'use strict';

const { trace, context: otelContext, propagation, SpanStatusCode } = require('@opentelemetry/api');

const TRACER_NAME = 'cap-mcp-guard';

/**
 * Maps a guard Context + Decision onto OTel span attributes. The Context's
 * gen_ai.* keys are already valid OTel GenAI semantic-convention attribute
 * names (that's why context.js was shaped this way back in M1) so they're
 * passed through as-is; cap-mcp-guard's own fields get a namespaced prefix
 * so they never collide with attributes a host app might already set.
 *
 * Pure — no OTel SDK calls, no I/O.
 *
 * @param {object} context see lib/core/context.js
 * @param {object} decision see lib/policy/evaluator.js
 * @returns {object} flat attribute map safe to pass to span.setAttributes()
 */
function buildSpanAttributes(context, decision) {
  const attributes = {};

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (key === 'traceparent' || key === 'tracestate') continue;
    attributes[key] = value;
  }

  attributes['cap_mcp_guard.mode'] = decision.mode;
  attributes['cap_mcp_guard.allowed'] = decision.allowed;
  attributes['cap_mcp_guard.fields_masked'] = decision.fieldsToMask;
  attributes['cap_mcp_guard.row_limit_exceeded'] = decision.rowLimitExceeded;

  if (decision.maxRows !== null && decision.maxRows !== undefined) {
    attributes['cap_mcp_guard.max_rows'] = decision.maxRows;
  }
  if (decision.reason) {
    attributes['cap_mcp_guard.reason'] = decision.reason;
  }

  return attributes;
}

/**
 * Resolves the parent OTel context from the Context's W3C traceparent/
 * tracestate (SEP-414), so a span started here links into whatever trace
 * the calling MCP runtime is already part of. If the host application
 * hasn't registered a propagator (or the request carried no traceparent),
 * this is a harmless no-op and the span simply starts its own trace.
 */
function extractParentContext(context) {
  if (!context.traceparent) return otelContext.active();

  const carrier = { traceparent: context.traceparent };
  if (context.tracestate) carrier.tracestate = context.tracestate;

  return propagation.extract(otelContext.active(), carrier);
}

/**
 * Records a single request's Context + Decision as a completed OTel span.
 *
 * Per OTel guidance for libraries (as opposed to applications), this never
 * registers a global TracerProvider or exporter itself — it only calls
 * trace.getTracer(), so it automatically ships spans through whatever OTLP
 * exporter (or none at all) the host application has configured. Without a
 * configured SDK, trace.getTracer() returns a no-op tracer and this is a
 * safe no-op, consistent with the rest of the guard's "no config = pass
 * through" behavior.
 *
 * The span is created retroactively with the request's real start/end
 * time (derived from context.timestamp and context.durationMs) rather
 * than wrapping the live request, since this runs from the `after` phase
 * once the request has already completed.
 *
 * @param {object} context see lib/core/context.js
 * @param {object} decision see lib/policy/evaluator.js
 * @param {object} [options]
 * @param {object} [options.tracer] injectable OTel tracer, defaults to
 *   trace.getTracer('cap-mcp-guard')
 * @returns {object} the ended span
 */
function exportSpan(context, decision, options = {}) {
  const { tracer = trace.getTracer(TRACER_NAME) } = options;

  const endTimeMs = Date.parse(context.timestamp);
  const startTimeMs =
    typeof context.durationMs === 'number' && Number.isFinite(endTimeMs)
      ? endTimeMs - context.durationMs
      : endTimeMs;

  const spanName = [context.operation, context.entity].filter(Boolean).join(' ') || 'cap-mcp-guard.request';
  const parentOtelContext = extractParentContext(context);

  const span = tracer.startSpan(spanName, { startTime: startTimeMs }, parentOtelContext);

  span.setAttributes(buildSpanAttributes(context, decision));
  span.setStatus({ code: decision.allowed ? SpanStatusCode.OK : SpanStatusCode.ERROR });
  span.end(endTimeMs);

  return span;
}

module.exports = { buildSpanAttributes, exportSpan, TRACER_NAME };