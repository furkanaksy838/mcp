'use strict';

/**
 * Builds a framework-agnostic request context object, shaped after the
 * OpenTelemetry GenAI semantic conventions (`gen_ai.*`) and the W3C Trace
 * Context fields propagated via MCP `_meta` (SEP-414: traceparent/tracestate).
 *
 * Pure function: given the same `input` and `now`, it always returns the
 * same shape. No CAP or OTel dependency lives here.
 *
 * @param {object} input
 * @param {string} [input.agentId]
 * @param {string} [input.agentName]
 * @param {string} [input.model]
 * @param {string} [input.traceparent]
 * @param {string} [input.tracestate]
 * @param {string} [input.entity]
 * @param {string} [input.operation]
 * @param {string} [input.tenant]
 * @param {string} [input.user]
 * @param {string} [input.session]
 * @param {string} [input.timestamp]
 * @param {number} [input.rowCount]
 * @param {number} [input.durationMs]
 * @param {object} [deps]
 * @param {() => string} [deps.now] injectable clock, defaults to ISO now
 * @returns {object} context object matching the guard's context schema
 */
function buildContext(input = {}, deps = {}) {
  const { now = () => new Date().toISOString() } = deps;

  const {
    agentId,
    agentName,
    model,
    traceparent,
    tracestate,
    entity,
    operation,
    tenant,
    user,
    session,
    timestamp,
    rowCount,
    durationMs
  } = input;

  return {
    'gen_ai.agent.id': agentId,
    'gen_ai.agent.name': agentName,
    'gen_ai.request.model': model,

    traceparent,
    tracestate,

    entity,
    operation,
    tenant,
    user,
    session,
    timestamp: timestamp || now(),
    rowCount: typeof rowCount === 'number' ? rowCount : undefined,
    durationMs: typeof durationMs === 'number' ? durationMs : undefined
  };
}

module.exports = { buildContext };