'use strict';

const { buildContext } = require('./context');
const { evaluate } = require('../policy/evaluator');
const { maskFields } = require('../policy/masking');

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
 * @param {(decision: object, req: object) => void} [options.onDecision]
 *   called with the Decision after each request completes, regardless of
 *   mode — this is the extension point M5 (audit log) will use
 * @param {() => string} [options.now] injectable clock, forwarded to buildContext
 */
function attachInterceptor(srv, options = {}) {
  if (!srv || typeof srv.before !== 'function' || typeof srv.after !== 'function') {
    throw new Error('attachInterceptor requires a CAP service exposing before()/after() hooks');
  }

  const { onContext, policyDefinition, onDecision, now } = options;
  const clockDeps = now ? { now } : {};

  srv.before('*', (req) => {
    if (!req) return;
    req._mcpGuardStartedAt = process.hrtime.bigint();
  });

  srv.after('*', (results, req) => {
    if (!req) return;

    const startedAt = req._mcpGuardStartedAt;
    const durationMs = startedAt === undefined
      ? undefined
      : Number(process.hrtime.bigint() - startedAt) / 1e6;

    const context = buildContext(
      {
        ...extractAgentInfo(req),
        ...extractTraceContext(req),
        entity: resolveEntity(req),
        operation: resolveOperation(req),
        tenant: req.tenant,
        user: req.user && req.user.id,
        session: req.id,
        rowCount: resolveRowCount(results),
        durationMs
      },
      clockDeps
    );

    if (typeof onContext === 'function') {
      onContext(context, req);
    }

    if (policyDefinition) {
      const decision = evaluate(context, policyDefinition);

      if (decision.mode === 'enforce' && decision.fieldsToMask.length > 0) {
        applyMask(results, decision.fieldsToMask);
      }

      if (typeof onDecision === 'function') {
        onDecision(decision, req);
      }
    }
  });
}

module.exports = { attachInterceptor };