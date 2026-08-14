'use strict';

function passThroughDecision(context, policyDefinition) {
  return {
    mode: policyDefinition.mode,
    allowed: true,
    reason: null,
    fieldsToMask: [],
    fieldsToPseudonymize: [],
    rowLimitExceeded: false,
    maxRows: null,
    entity: context.entity,
    timestamp: context.timestamp
  };
}

/**
 * Evaluates a request Context (lib/core/context.js) against a
 * PolicyDefinition (lib/policy/config.js) and produces a Decision — what
 * *should* happen for this request. Nothing is enforced here: no fields are
 * removed, no request is blocked, nothing is logged. Those are M4 (masking)
 * and M5 (audit)'s job.
 *
 * Pure function: same inputs, same output. No CAP dependency.
 *
 * @param {object} context see lib/core/context.js buildContext() shape
 * @param {object} policyDefinition see lib/policy/config.js parseConfig() shape
 * @returns {object} Decision
 */
/**
 * Whether the request arrived on one of the paths the policy is scoped to.
 *
 * Prefix match, so `"/mcp"` covers `/mcp`, `/mcp/`, and whatever the runtime appends.
 *
 * A request carrying no path at all is a third case rather than simply "not matching", and the
 * difference matters. It means the guard could not tell which door this came through — an internal
 * call with no HTTP context, a runtime that queries the service without preserving the outer
 * request, a duck-typed caller. Treating that as out of scope returns real values, and returns them
 * silently: a 200 with an empty fieldsToMask, indistinguishable from an entity nobody meant to mask.
 *
 * So the default is to apply the policy when the path is unknown. Masked data reaching something
 * that wanted real data is a visible failure — somebody sees '***MASKED***' where a number belongs
 * and comes asking. Real data reaching something that should have been masked is not visible at all.
 * Between a loud wrong answer and a quiet one, the loud one is the one you can fix.
 *
 * `whenPathUnknown: 'pass'` opts back out, for a project whose internal jobs legitimately run
 * without an HTTP context and need the real values.
 */
function pathInScope(paths, path, whenPathUnknown) {
  if (typeof path !== 'string') return whenPathUnknown !== 'pass';
  return paths.some((prefix) => path === prefix || path.startsWith(prefix));
}

function evaluate(context, policyDefinition) {
  // policyDefinition.paths, when set, scopes enforcement to requests that arrived on one of those
  // inbound HTTP paths — the URL an agent-serving runtime is mounted at, typically. Unlike `users`,
  // this does not rest on a claim the caller makes about itself: a request either arrived at that
  // door or it did not.
  //
  // The half that is NOT here, and cannot be: nothing about this stops the same caller from asking
  // the *other* door instead, where the policy simply doesn't apply and the answer is unmasked. Path
  // scoping decides what happens to requests at the door it names; closing the other doors is
  // authorization, which belongs to CAP's own @requires/@restrict or to whatever sits in front of
  // it. adapters/cap.js reports at startup when only half of that is in place, because a config
  // that masks one door and leaves the next one open reads exactly like a working one.
  if (
    Array.isArray(policyDefinition.paths) &&
    !pathInScope(policyDefinition.paths, context.path, policyDefinition.whenPathUnknown)
  ) {
    return passThroughDecision(context, policyDefinition);
  }

  // policyDefinition.users, when set, scopes enforcement to just those identities
  // (context.user, populated from CAP's own verified req.user.id) — e.g. a technical
  // user the MCP runtime authenticates as, distinct from a human UI user hitting the
  // same service. A request from anyone not in the list is fully allowed/unmasked,
  // as if this entity had no policy at all.
  if (Array.isArray(policyDefinition.users) && !policyDefinition.users.includes(context.user)) {
    return passThroughDecision(context, policyDefinition);
  }

  const entityConfig = policyDefinition.entities[context.entity];

  if (!entityConfig) {
    return passThroughDecision(context, policyDefinition);
  }

  const { allowTools, maxRows, mask, pseudonymize } = entityConfig;
  const protectedFields = new Set([...(mask ?? []), ...(pseudonymize ?? []).map((entry) => entry.field)]);

  let allowed = true;
  let reason = null;
  if (Array.isArray(allowTools) && !allowTools.includes(context.operation)) {
    allowed = false;
    reason = `tool '${context.operation}' not in allowTools for entity '${context.entity}'`;
  }

  // Masking rewrites the response, so a request that *computes over* a protected field — filters,
  // sorts, groups or aggregates by it — still runs against the real column. The values never appear
  // in the payload, but which rows come back, in what order, and what they sum to all do, and that
  // is enough: repeated range filters recover an exact value by bisection. Refusing the request is
  // the only honest answer, since there is nothing to rewrite after the fact.
  if (allowed) {
    const offending = (context.queryFields ?? []).filter((field) => protectedFields.has(field));
    if (offending.length > 0) {
      allowed = false;
      reason =
        `query computes over protected field(s) ${offending.map((f) => `'${f}'`).join(', ')} on entity ` +
        `'${context.entity}' — $filter/$orderby/$groupby/aggregation run against the real values, ` +
        'so the result would disclose them even though the response is masked';
    }
  }

  // The same in the other direction: a caller that only ever sees a placeholder or a pseudonym for
  // a field cannot send a meaningful value back, and writing what it did read replaces the real
  // value with the fake one.
  if (allowed) {
    const offending = (context.writeFields ?? []).filter((field) => protectedFields.has(field));
    if (offending.length > 0) {
      allowed = false;
      reason =
        `write targets protected field(s) ${offending.map((f) => `'${f}'`).join(', ')} on entity ` +
        `'${context.entity}' — the caller only ever reads them masked, so writing them back would ` +
        'overwrite the real value';
    }
  }

  const rowLimitExceeded =
    typeof maxRows === 'number' && typeof context.rowCount === 'number' && context.rowCount > maxRows;

  return {
    mode: policyDefinition.mode,
    allowed,
    reason,
    fieldsToMask: mask ?? [],
    fieldsToPseudonymize: pseudonymize ?? [],
    rowLimitExceeded,
    maxRows: typeof maxRows === 'number' ? maxRows : null,
    entity: context.entity,
    timestamp: context.timestamp
  };
}

module.exports = { evaluate };