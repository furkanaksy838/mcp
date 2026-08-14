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
 * @param {string[]} [input.queryFields] field names the request *computes over* rather than merely
 *   selects — everything referenced by $filter, $orderby, $groupby and aggregations. Masking
 *   rewrites the response, so a query that filters or sorts by a masked field still runs against
 *   the real column and leaks through which rows come back and in what order; the evaluator needs
 *   to see these to refuse such a request.
 * @param {string[]} [input.writeFields] field names an inbound write is carrying, for the same
 *   reason in the other direction: a field the caller can only read masked is a field it must not
 *   be able to write, or it overwrites the real value with a placeholder.
 * @param {string} [input.path] the inbound HTTP path the request arrived on. What makes this worth
 *   carrying is that a runtime serving an agent (an MCP endpoint, say) reaches the same CAP service
 *   the UI does, but through its own URL — and unlike an identity, which the caller asserts, the
 *   path is where the request actually arrived. See policyDefinition.paths in policy/evaluator.js.
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
    durationMs,
    queryFields,
    writeFields,
    path
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
    path,
    timestamp: timestamp || now(),
    rowCount: typeof rowCount === 'number' ? rowCount : undefined,
    durationMs: typeof durationMs === 'number' ? durationMs : undefined,
    queryFields: Array.isArray(queryFields) && queryFields.length > 0 ? queryFields : undefined,
    writeFields: Array.isArray(writeFields) && writeFields.length > 0 ? writeFields : undefined
  };
}

module.exports = { buildContext };