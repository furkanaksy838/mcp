'use strict';

const { buildContext } = require('./context');
const { evaluate } = require('../policy/evaluator');
const { maskFields } = require('../policy/masking');
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

function resolveRowCount(results) {
  if (Array.isArray(results)) return results.length;
  if (results === undefined || results === null) return 0;
  return 1;
}

/**
 * Applies masked field values onto the live CAP results (single row or
 * array of rows), mutating them in place — CAP reflects in-place edits
 * made in an `after` handler back into the actual response. maskFields()
 * itself stays pure; this is the one place that turns its (immutable)
 * output into a real effect on the request.
 */
function applyMask(results, fieldsToMask) {
  const masked = maskFields(results, fieldsToMask);
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
      targetEntity: (el._target && el._target.name) || el.target
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
function applyNestedPolicy(results, target, policyDefinition, context, pseudonymSecret) {
  const associations = findAssociationElements(target);
  if (!associations.length) return;

  const rows = Array.isArray(results) ? results : [results];
  const decisions = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    for (const { name, targetEntity } of associations) {
      const navValue = row[name];
      if (navValue === undefined || navValue === null) continue;

      if (!decisions.has(targetEntity)) {
        decisions.set(targetEntity, evaluate({ ...context, entity: targetEntity }, policyDefinition));
      }
      const decision = decisions.get(targetEntity);
      if (decision.mode !== 'enforce') continue;

      if (decision.fieldsToMask.length > 0) {
        applyMask(navValue, decision.fieldsToMask);
      }
      if (decision.fieldsToPseudonymize.length > 0) {
        applyPseudonymize(navValue, decision.fieldsToPseudonymize, pseudonymSecret);
      }
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

    // allowTools is a gate, not a masking rule — it has to be enforced before the
    // query runs, not after. rowCount/durationMs aren't known yet, but `allowed`
    // never depends on either, so this decision is already final.
    const context = buildRequestContext(req, {});
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
    }
  });

  srv.after('*', (results, req) => {
    if (!req) return;

    const startedAt = req._mcpGuardStartedAt;
    const durationMs = startedAt === undefined
      ? undefined
      : Number(process.hrtime.bigint() - startedAt) / 1e6;

    const context = buildRequestContext(req, { rowCount: resolveRowCount(results), durationMs });

    if (typeof onContext === 'function') {
      onContext(context, req);
    }

    if (policyDefinition) {
      const decision = evaluate(context, policyDefinition);

      if (decision.mode === 'enforce' && decision.fieldsToMask.length > 0) {
        applyMask(results, decision.fieldsToMask);
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
      applyNestedPolicy(results, req.target, policyDefinition, context, pseudonymSecret);

      if (typeof onDecision === 'function') {
        onDecision(decision, context, req);
      }
    }
  });
}

module.exports = { attachInterceptor };