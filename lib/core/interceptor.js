'use strict';

const { buildContext } = require('./context');
const { evaluate } = require('../policy/evaluator');
const { maskFields, applyMaskRule, MASK_VALUE } = require('../policy/masking');
const { generatePseudonym } = require('../policy/pseudonym');

/**
 * Reads W3C Trace Context fields propagated by the MCP runtime.
 * SEP-414 carries these via `_meta.traceparent` / `_meta.tracestate`; HTTP
 * transports may also set the headers directly. Missing values are fine —
 * this never throws for a request that has neither.
 */
function extractTraceContext(req) {
  const meta = (req && req._meta) || (req && req.data && req.data._meta) || {};
  const headers = (req && req.http && req.http.req && req.http.req.headers) || {};

  return {
    traceparent: meta.traceparent || headers.traceparent,
    tracestate: meta.tracestate || headers.tracestate
  };
}

/**
 * Reads AI-agent identity fields. Until an MCP runtime is wired in, these
 * arrive (if at all) via the same `_meta` bag as the trace context.
 */
function extractAgentInfo(req) {
  const meta = (req && req._meta) || (req && req.data && req.data._meta) || {};

  return {
    agentId: meta['gen_ai.agent.id'],
    agentName: meta['gen_ai.agent.name'],
    model: meta['gen_ai.request.model']
  };
}

function resolveEntity(req) {
  if (!req) return undefined;
  if (typeof req.entity === 'string') return req.entity;
  if (req.target && req.target.name) return req.target.name;
  return undefined;
}

function resolveOperation(req) {
  return (req && req.event) || undefined;
}

/**
 * Collects the field names a request *computes over*, as opposed to merely selects: everything
 * referenced by $filter, $orderby, $groupby, $having, and by any computed column (an aggregate like
 * `sum(salary)`, an expression, a function call).
 *
 * A bare `{ref: ['salary']}` in the column list is deliberately NOT collected — that is just asking
 * for the field, which is exactly what masking handles. What has to be caught is the field being
 * used to shape the result, because that part of the query runs against the real column and the
 * result discloses it regardless of what the response body says.
 *
 * Walks CQN generically rather than matching known shapes, so an aggregation the OData layer
 * compiles into some structure this code has never seen still surfaces its refs.
 *
 * @param {object} query req.query (CQN) — anything but a SELECT yields an empty list
 * @returns {string[]} distinct field names, in encounter order
 */
function collectQueryFields(query) {
  const select = query && query.SELECT;
  if (!select) return [];

  const found = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.ref)) {
      for (const segment of node.ref) {
        if (typeof segment === 'string') found.add(segment);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'ref') continue;
      walk(value);
    }
  };

  walk(select.where);
  walk(select.orderBy);
  walk(select.groupBy);
  walk(select.having);

  for (const column of select.columns || []) {
    if (!column || typeof column !== 'object') continue;
    // A plain projection of a field, possibly with a nested $expand: not a computation over it.
    // (The nested query belongs to another entity and is evaluated on its own when its rows come
    // back — see applyNestedPolicy.)
    const isPlainRef = Array.isArray(column.ref) && !column.func && !column.xpr && !column.args;
    if (isPlainRef) continue;
    walk(column);
  }

  return [...found];
}

/**
 * Field names an inbound write is carrying, so a caller that only reads a field masked can be
 * stopped from writing it. Handles the bulk case, where req.data is an array of rows.
 */
function collectWriteFields(req) {
  const data = req && req.data;
  if (!data || typeof data !== 'object') return [];

  const rows = Array.isArray(data) ? data : [data];
  const found = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) found.add(key);
  }

  return [...found];
}

const WRITE_EVENTS = new Set(['CREATE', 'UPDATE', 'UPSERT', 'DELETE', 'PATCH', 'PUT']);

function isWriteEvent(event) {
  return WRITE_EVENTS.has(String(event || '').toUpperCase());
}

/**
 * Clamps a READ's row limit to `maxRows` on the query itself, before it runs.
 *
 * The `after` hook truncates the response too, and that alone is what `maxRows` used to be: the
 * database still read every row, shipped it, and had it held in memory so that most of it could be
 * thrown away. On a large table that is the whole cost of the query for none of the benefit. A
 * client asking for fewer rows keeps its own smaller limit.
 *
 * @returns {boolean} whether a limit was applied or tightened
 */
function applyRowLimitToQuery(query, maxRows) {
  const select = query && query.SELECT;
  if (!select || typeof maxRows !== 'number') return false;

  const existing = select.limit && select.limit.rows;
  const existingRows = existing && typeof existing.val === 'number' ? existing.val : undefined;

  if (existingRows !== undefined && existingRows <= maxRows) return false;

  select.limit = { ...(select.limit || {}), rows: { val: maxRows } };
  return true;
}

function resolveRowCount(results) {
  if (Array.isArray(results)) return results.length;
  if (results === undefined || results === null) return 0;
  return 1;
}

// Backstop for nested-policy recursion. Recursion follows the response data, which is finite, so
// this is not the contract — just a guard against a pathologically deep payload.
const MAX_NESTED_DEPTH = 10;

// Only these can hold the '***MASKED***' placeholder without contradicting the type the service
// publishes for them. cds.UUID is deliberately not here: it is a string in JS but surfaces as
// Edm.Guid, and the placeholder is not a GUID.
const PLACEHOLDER_SAFE_TYPES = new Set(['cds.String', 'cds.LargeString']);

/**
 * Picks the replacement for each masked field, given the requested entity's compiled elements.
 *
 * A single field can only have one type, and it is the one the service publishes in $metadata.
 * Writing '***MASKED***' into an Edm.Decimal or Edm.Date property makes the response contradict
 * that, and typed consumers can't do anything with it: Fiori Elements renders an empty cell
 * (indistinguishable from "no value"), a generated client fails to parse. So anything that isn't
 * a plain string field is masked to `null` instead — type-valid everywhere, and the record of
 * *which* fields were withheld travels in the Decision, so it still reaches the audit log and
 * the OTel span.
 *
 * Falls back to the placeholder for every field when `elements` isn't available (no linked CSN
 * on the request, e.g. a duck-typed service in tests) or when a field isn't among them — with no
 * type to go on, the previous behavior is the safer guess.
 *
 * That default assumes a typed consumer. It is wrong for the setup where the *same* entity serves
 * both audiences and only the agent's copy is masked — there Fiori always receives real Decimals
 * and the masked payload only ever reaches something reading JSON, for which a string placeholder
 * is strictly more informative than a null it can't distinguish from an empty column. So the
 * caller can turn it off: `maskTypeSafe: false` writes the placeholder into every masked field
 * regardless of type, and `maskValue` chooses what that placeholder is. The other way to get the
 * same result is to model the field as text on an agent-facing projection
 * (`cast(salary as String(20)) as salary`), which needs no configuration but does need a second
 * projection.
 *
 * @param {string[]} fieldsToMask
 * @param {object} [elements] req.target.elements
 * @param {object} [maskOptions]
 * @param {string} [maskOptions.value] placeholder, defaults to '***MASKED***'
 * @param {boolean} [maskOptions.typeSafe] defaults to true; false writes the placeholder into
 *   every masked field, accepting that a non-string field then contradicts its own $metadata
 * @returns {object} {field: replacement} for maskFields()
 */
function resolveMaskValues(fieldsToMask, elements, maskOptions = {}, maskRules) {
  const { value = MASK_VALUE, typeSafe = true } = maskOptions;
  const values = {};

  for (const field of fieldsToMask) {
    const element = elements && elements[field];
    const isStringField = !element || PLACEHOLDER_SAFE_TYPES.has(element.type);
    const fullValue = !typeSafe || isStringField ? value : null;
    const rule = maskRules && maskRules[field];

    // partial/email derive their output from the real value, so unlike a placeholder they can only
    // be computed per row. They also produce a string, which a non-string field can't hold — there
    // the full replacement stands in, and the lint reports the mismatch at startup.
    if (rule && (isStringField || !typeSafe)) {
      values[field] = (currentValue) => {
        const replaced = applyMaskRule(currentValue, rule);
        return replaced === undefined ? fullValue : replaced;
      };
      continue;
    }

    values[field] = fullValue;
  }

  return values;
}

/**
 * The per-field mask strategies configured for an entity, if any (see config.js#normalizeMask).
 * Read from the policy rather than carried on the Decision, so the audit line and the OTel span
 * keep publishing `fieldsToMask` as the plain list of names they always did.
 */
function maskRulesFor(policyDefinition, entityName) {
  const entityConfig = policyDefinition && policyDefinition.entities && policyDefinition.entities[entityName];
  return entityConfig && entityConfig.maskRules;
}

/**
 * Applies masked field values onto the live CAP results (single row or
 * array of rows), mutating them in place — CAP reflects in-place edits
 * made in an `after` handler back into the actual response. maskFields()
 * itself stays pure; this is the one place that turns its (immutable)
 * output into a real effect on the request.
 *
 * @param {object|object[]} results
 * @param {string[]} fieldsToMask
 * @param {object} [elements] the masked entity's compiled elements, used to keep each
 *   replacement compatible with the field's published type (see resolveMaskValues)
 */
function applyMask(results, fieldsToMask, elements, maskOptions, maskRules) {
  const maskValues = resolveMaskValues(fieldsToMask, elements, maskOptions, maskRules);
  const masked = maskFields(results, fieldsToMask, maskValues);
  const items = Array.isArray(results) ? results : [results];
  const maskedItems = Array.isArray(masked) ? masked : [masked];

  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const maskedItem = maskedItems[i];
    for (const field of fieldsToMask) {
      if (Object.prototype.hasOwnProperty.call(item, field)) {
        item[field] = maskedItem[field];
      }
    }
  });
}

/**
 * Replaces each listed field's real value with a deterministic pseudonym (see
 * lib/policy/pseudonym.js) — same real value always produces the same fake one, so an
 * AI agent can still tell rows apart without ever seeing the real data. Mutates `results`
 * in place, same convention as applyMask().
 *
 * @param {object|object[]} results
 * @param {{field: string, type: string}[]} fieldsToPseudonymize
 * @param {string} secret required whenever fieldsToPseudonymize is non-empty (see
 *   lib/adapters/cap.js, which resolves and validates this before attachInterceptor runs)
 */
function applyPseudonymize(results, fieldsToPseudonymize, secret) {
  const items = Array.isArray(results) ? results : [results];

  items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    for (const { field, type, value: customValue, group } of fieldsToPseudonymize) {
      if (Object.prototype.hasOwnProperty.call(item, field)) {
        item[field] = generatePseudonym(field, item[field], type, secret, customValue, group);
      }
    }
  });
}

/**
 * Finds the association/composition elements on a CAP entity definition, along with the
 * (already service-qualified) entity name each one targets — e.g. for `Employees.department`,
 * `{ name: 'department', targetEntity: 'CatalogService.Departments' }`. That target name is
 * exactly what a request against `Departments` directly would resolve via resolveEntity(),
 * so the same `policyDefinition.entities` keys apply to nested rows without any separate
 * EDM/$metadata resolution — CAP's own compiled model already carries it.
 *
 * @param {object} target req.target — a linked CSN entity definition, or undefined
 * @returns {{name: string, targetEntity: string}[]}
 */
function findAssociationElements(target) {
  if (!target || !target.elements) return [];

  return Object.entries(target.elements)
    .filter(([, el]) => el && (el.type === 'cds.Association' || el.type === 'cds.Composition'))
    .map(([name, el]) => ({
      name,
      targetEntity: (el._target && el._target.name) || el.target,
      // The linked target's own elements, so nested masking can keep each replacement
      // type-compatible too (see resolveMaskValues). Absent on an unlinked/duck-typed model,
      // which resolveMaskValues handles by falling back to the placeholder.
      targetElements: el._target && el._target.elements,
      // The linked target definition itself, which carries its own associations — this is what
      // lets nested masking continue past the first level without the adapter having to hand in a
      // model lookup.
      targetDef: el._target
    }))
    .filter((assoc) => assoc.targetEntity);
}

/**
 * Applies each expanded association's own policy (mask/pseudonymize) to the nested
 * row(s) hanging off of it — one level deep, matching what `$expand` actually returns.
 * Mutates `results` in place, same convention as applyMask()/applyPseudonymize(). A no-op
 * when the request's entity has no associations, or none of them were expanded (the nav
 * property is simply absent from the row), or the target entity has no policy configured.
 *
 * Each nested entity goes through evaluate() with the request's own Context, only with
 * `entity` swapped for the association's target. That matters for more than tidiness: this
 * used to read policyDefinition.entities directly, which skipped every scoping rule the
 * evaluator applies. With `users` set, a request from an identity *outside* the list came back
 * correctly unmasked at the top level and then had its expanded rows masked anyway — the UI
 * seeing '***MASKED***' inside $expand while reading the same field fine directly. Routing
 * through evaluate() keeps nested rows and direct reads answering to one set of rules by
 * construction, mode included (observe touches nothing).
 *
 * @param {object|object[]} results
 * @param {object} target req.target — see findAssociationElements()
 * @param {object} policyDefinition see lib/policy/config.js
 * @param {object} context the request's Context (see lib/core/context.js), reused per nested
 *   entity so identity-based scoping applies to expanded rows exactly as it does to direct ones
 * @param {string} [pseudonymSecret] forwarded to applyPseudonymize() for nested fields
 */
function applyNestedPolicy(
  results,
  target,
  policyDefinition,
  context,
  pseudonymSecret,
  maskOptions,
  decisions = new Map(),
  depth = 0
) {
  if (depth >= MAX_NESTED_DEPTH) return;

  const associations = findAssociationElements(target);
  if (!associations.length) return;

  const rows = Array.isArray(results) ? results : [results];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    for (const { name, targetEntity, targetElements, targetDef } of associations) {
      const navValue = row[name];
      if (navValue === undefined || navValue === null) continue;

      if (!decisions.has(targetEntity)) {
        decisions.set(targetEntity, evaluate({ ...context, entity: targetEntity }, policyDefinition));
      }
      const decision = decisions.get(targetEntity);

      if (decision.mode === 'enforce') {
        if (decision.fieldsToMask.length > 0) {
          applyMask(navValue, decision.fieldsToMask, targetElements, maskOptions, maskRulesFor(policyDefinition, targetEntity));
        }
        if (decision.fieldsToPseudonymize.length > 0) {
          applyPseudonymize(navValue, decision.fieldsToPseudonymize, pseudonymSecret);
        }
      }

      // Keep going into the expanded rows' own expansions. Stopping at one level meant an agent
      // able to navigate A -> B -> A read raw values on the second hop: literally the same row,
      // masked at the top of the response and untouched further in. Recursion follows the data, so
      // it ends when the response does; MAX_NESTED_DEPTH is a backstop, not the contract.
      if (!targetDef) continue;
      applyNestedPolicy(
        navValue,
        targetDef,
        policyDefinition,
        { ...context, entity: targetEntity },
        pseudonymSecret,
        maskOptions,
        decisions,
        depth + 1
      );
    }
  }
}

/**
 * Attaches request interception to a CAP service instance, producing a
 * guard context (see context.js) for every request that passes through it.
 *
 * If a `policyDefinition` is supplied, each context is also evaluated (see
 * policy/evaluator.js) into a Decision. In `enforce` mode, any fields the
 * Decision names in `fieldsToMask` are redacted on the real response before
 * it reaches the caller. In `observe` mode the response is never touched —
 * the Decision is still computed and handed to `onDecision`, but nothing
 * about the request's outcome changes. Without a `policyDefinition`, this
 * only observes and builds context — the M1 behavior.
 *
 * @param {object} srv a CAP service exposing before()/after() (duck-typed —
 *   this module never imports @sap/cds)
 * @param {object} [options]
 * @param {(context: object, req: object) => void} [options.onContext]
 *   called with the built context after each request completes
 * @param {object} [options.policyDefinition] see lib/policy/config.js —
 *   when omitted, no policy evaluation or masking happens
 * @param {(decision: object, context: object, req: object) => void} [options.onDecision]
 *   called with the Decision (and the Context it was computed from) after
 *   each request completes, regardless of mode — this is the extension
 *   point M5 (audit log) uses
 * @param {() => string} [options.now] injectable clock, forwarded to buildContext
 * @param {string} [options.pseudonymSecret] required whenever any entity configures
 *   `pseudonymize` — resolved and validated one layer up in lib/adapters/cap.js
 */
function attachInterceptor(srv, options = {}) {
  if (!srv || typeof srv.before !== 'function' || typeof srv.after !== 'function') {
    throw new Error('attachInterceptor requires a CAP service exposing before()/after() hooks');
  }

  const { onContext, policyDefinition, onDecision, now, pseudonymSecret } = options;

  // Read once: the placeholder and whether it has to fit the field's published type. Both live on
  // the PolicyDefinition so they can be set in package.json without hand-wiring this call.
  const maskOptions = {
    ...(policyDefinition && policyDefinition.maskValue !== undefined && { value: policyDefinition.maskValue }),
    ...(policyDefinition && policyDefinition.maskTypeSafe !== undefined && { typeSafe: policyDefinition.maskTypeSafe })
  };
  const clockDeps = now ? { now } : {};

  function buildRequestContext(req, extra) {
    return buildContext(
      {
        ...extractAgentInfo(req),
        ...extractTraceContext(req),
        entity: resolveEntity(req),
        operation: resolveOperation(req),
        tenant: req.tenant,
        user: req.user && req.user.id,
        session: req.id,
        ...extra
      },
      clockDeps
    );
  }

  srv.before('*', (req) => {
    if (!req) return;
    req._mcpGuardStartedAt = process.hrtime.bigint();

    if (!policyDefinition) return;

    // Three gates that have to run before the query does, not after: allowTools, a query that
    // computes over a protected field, and a write that targets one. None of them are fixable by
    // rewriting the response — by the time rows come back, a filtered/sorted/aggregated result has
    // already disclosed what it discloses, and a write has already been accepted. rowCount and
    // durationMs aren't known yet, but `allowed` never depends on either, so this decision is final.
    // Stashed so the `after` hook can rebuild an equivalent context. Without it, an observe-mode
    // request that a filter over a masked field *would* have been refused for reports as plainly
    // allowed — the one mode whose entire job is saying what would have happened.
    req._mcpGuardGateFields = {
      queryFields: collectQueryFields(req.query),
      writeFields: isWriteEvent(req.event) ? collectWriteFields(req) : undefined
    };

    const context = buildRequestContext(req, req._mcpGuardGateFields);
    const decision = evaluate(context, policyDefinition);

    if (decision.mode === 'enforce' && !decision.allowed) {
      // req.reject() throws in real CAP requests, so srv.after('*') below never runs
      // for a denied request — report it here instead, or the denial would never be
      // audited/traced at all.
      if (typeof onContext === 'function') onContext(context, req);
      if (typeof onDecision === 'function') onDecision(decision, context, req);

      if (typeof req.reject === 'function') {
        req.reject(403, decision.reason);
      } else {
        throw new Error(decision.reason);
      }
      return;
    }

    // maxRows pushed onto the query rather than only truncating the response, so the database
    // stops reading rows that were always going to be discarded.
    if (decision.mode === 'enforce' && typeof decision.maxRows === 'number') {
      applyRowLimitToQuery(req.query, decision.maxRows);
    }
  });

  srv.after('*', (results, req) => {
    if (!req) return;

    const startedAt = req._mcpGuardStartedAt;
    const durationMs = startedAt === undefined
      ? undefined
      : Number(process.hrtime.bigint() - startedAt) / 1e6;

    const context = buildRequestContext(req, {
      rowCount: resolveRowCount(results),
      durationMs,
      ...(req._mcpGuardGateFields || {})
    });

    if (typeof onContext === 'function') {
      onContext(context, req);
    }

    if (policyDefinition) {
      const decision = evaluate(context, policyDefinition);

      if (decision.mode === 'enforce' && decision.fieldsToMask.length > 0) {
        applyMask(
          results,
          decision.fieldsToMask,
          req.target && req.target.elements,
          maskOptions,
          maskRulesFor(policyDefinition, context.entity)
        );
      }

      if (decision.mode === 'enforce' && decision.fieldsToPseudonymize.length > 0) {
        applyPseudonymize(results, decision.fieldsToPseudonymize, pseudonymSecret);
      }

      if (decision.mode === 'enforce' && decision.rowLimitExceeded && Array.isArray(results)) {
        results.length = decision.maxRows;
      }

      // Unconditional: each nested entity is evaluated on its own (see applyNestedPolicy), and
      // a nested decision that isn't `enforce` touches nothing. Gating on this request's own
      // mode here would be redundant, and gating on its fieldsToMask would be wrong — an
      // entity with no policy of its own can still expand into one that has.
      applyNestedPolicy(results, req.target, policyDefinition, context, pseudonymSecret, maskOptions);

      if (typeof onDecision === 'function') {
        onDecision(decision, context, req);
      }
    }
  });
}

module.exports = { attachInterceptor };