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
function evaluate(context, policyDefinition) {
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

  let allowed = true;
  let reason = null;
  if (Array.isArray(allowTools) && !allowTools.includes(context.operation)) {
    allowed = false;
    reason = `tool '${context.operation}' not in allowTools for entity '${context.entity}'`;
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