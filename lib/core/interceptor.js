'use strict';

const { buildContext } = require('./context');

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
 * Attaches request interception to a CAP service instance, producing a
 * guard context (see context.js) for every request that passes through it.
 *
 * This only observes and builds context — it does not enforce policy, mask
 * fields, log, or export telemetry. Those are later milestones.
 *
 * @param {object} srv a CAP service exposing before()/after() (duck-typed —
 *   this module never imports @sap/cds)
 * @param {object} [options]
 * @param {(context: object, req: object) => void} [options.onContext]
 *   called with the built context after each request completes
 * @param {() => string} [options.now] injectable clock, forwarded to buildContext
 */
function attachInterceptor(srv, options = {}) {
  if (!srv || typeof srv.before !== 'function' || typeof srv.after !== 'function') {
    throw new Error('attachInterceptor requires a CAP service exposing before()/after() hooks');
  }

  const { onContext, now } = options;
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
  });
}

module.exports = { attachInterceptor };