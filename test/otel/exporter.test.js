'use strict';

const { trace, SpanStatusCode, propagation } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');

const { buildSpanAttributes, exportSpan, TRACER_NAME } = require('../../lib/otel/exporter');

function context(overrides = {}) {
  return {
    'gen_ai.agent.id': 'agent-1',
    'gen_ai.agent.name': 'Claude Desktop',
    'gen_ai.request.model': 'claude-sonnet-5',
    traceparent: undefined,
    tracestate: undefined,
    entity: 'CatalogService.Books',
    operation: 'READ',
    tenant: undefined,
    user: 'anonymous',
    session: 'sess-1',
    timestamp: '2026-07-18T00:00:00.500Z',
    rowCount: 3,
    durationMs: 12.5,
    ...overrides
  };
}

function decision(overrides = {}) {
  return {
    mode: 'enforce',
    allowed: true,
    reason: null,
    fieldsToMask: ['price'],
    rowLimitExceeded: false,
    maxRows: null,
    entity: 'CatalogService.Books',
    timestamp: '2026-07-18T00:00:00.500Z',
    ...overrides
  };
}

describe('buildSpanAttributes', () => {
  test('maps context fields (already gen_ai.*-shaped) straight through, dropping undefined and trace-context fields', () => {
    const attrs = buildSpanAttributes(context(), decision());

    expect(attrs['gen_ai.agent.id']).toBe('agent-1');
    expect(attrs['gen_ai.agent.name']).toBe('Claude Desktop');
    expect(attrs.entity).toBe('CatalogService.Books');
    expect(attrs.rowCount).toBe(3);
    expect(attrs).not.toHaveProperty('traceparent');
    expect(attrs).not.toHaveProperty('tracestate');
    expect(attrs).not.toHaveProperty('tenant'); // was undefined in context()
  });

  test('namespaces decision fields under cap_mcp_guard.*', () => {
    const attrs = buildSpanAttributes(context(), decision({ fieldsToMask: ['price', 'descr'] }));

    expect(attrs['cap_mcp_guard.mode']).toBe('enforce');
    expect(attrs['cap_mcp_guard.allowed']).toBe(true);
    expect(attrs['cap_mcp_guard.fields_masked']).toEqual(['price', 'descr']);
    expect(attrs['cap_mcp_guard.row_limit_exceeded']).toBe(false);
  });

  test('omits maxRows/reason attributes when the Decision has none', () => {
    const attrs = buildSpanAttributes(context(), decision({ maxRows: null, reason: null }));
    expect(attrs).not.toHaveProperty('cap_mcp_guard.max_rows');
    expect(attrs).not.toHaveProperty('cap_mcp_guard.reason');
  });

  test('includes maxRows/reason attributes when the Decision has them', () => {
    const attrs = buildSpanAttributes(
      context(),
      decision({ maxRows: 50, reason: "tool 'DELETE' not in allowTools for entity 'Orders'" })
    );
    expect(attrs['cap_mcp_guard.max_rows']).toBe(50);
    expect(attrs['cap_mcp_guard.reason']).toBe("tool 'DELETE' not in allowTools for entity 'Orders'");
  });
});

describe('exportSpan', () => {
  let memoryExporter;
  let provider;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    memoryExporter.reset();
    await provider.shutdown();
    trace.disable();
    propagation.disable();
  });

  test('records a span named "<operation> <entity>" with the request timing and attributes', () => {
    exportSpan(context(), decision());

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.name).toBe('READ CatalogService.Books');
    expect(span.attributes['gen_ai.agent.id']).toBe('agent-1');
    expect(span.attributes['cap_mcp_guard.mode']).toBe('enforce');

    const endMs = Date.parse('2026-07-18T00:00:00.500Z');
    expect(span.endTime[0] * 1000 + span.endTime[1] / 1e6).toBeCloseTo(endMs, -1);
    const durationMs = (span.duration[0] * 1e9 + span.duration[1]) / 1e6;
    expect(durationMs).toBeCloseTo(12.5, 0);
  });

  test('sets span status OK when allowed, ERROR when not', () => {
    exportSpan(context(), decision({ allowed: true }));
    exportSpan(context(), decision({ allowed: false, reason: 'blocked' }));

    const [okSpan, errorSpan] = memoryExporter.getFinishedSpans();
    expect(okSpan.status.code).toBe(SpanStatusCode.OK);
    expect(errorSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  test('falls back to a generic span name when entity/operation are both missing', () => {
    exportSpan(context({ entity: undefined, operation: undefined }), decision({ entity: undefined }));
    expect(memoryExporter.getFinishedSpans()[0].name).toBe('cap-mcp-guard.request');
  });

  test('uses an injected tracer instead of the global one when given', () => {
    const customExporter = new InMemorySpanExporter();
    const customProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(customExporter)] });
    const customTracer = customProvider.getTracer('custom');

    exportSpan(context(), decision(), { tracer: customTracer });

    expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    expect(customExporter.getFinishedSpans()).toHaveLength(1);
  });

  test('links the span into the trace named by a W3C traceparent when a propagator is registered', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const traceparent = `00-${incomingTraceId}-00f067aa0ba902b7-01`;

    exportSpan(context({ traceparent }), decision());

    const span = memoryExporter.getFinishedSpans()[0];
    expect(span.spanContext().traceId).toBe(incomingTraceId);
  });

  test('starts a fresh trace when there is no traceparent, without throwing', () => {
    expect(() => exportSpan(context({ traceparent: undefined }), decision())).not.toThrow();
    expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe('module exports', () => {
  test('exposes a stable tracer name', () => {
    expect(TRACER_NAME).toBe('cap-mcp-guard');
  });
});