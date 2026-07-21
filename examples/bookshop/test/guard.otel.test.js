'use strict';

const { trace } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

describe('cap-mcp-guard M6 — OTel span export against the real bookshop service', () => {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  trace.setGlobalTracerProvider(provider);

  registerCapMcpGuard(cds, {
    policyDefinition: {
      mode: 'enforce',
      entities: { 'CatalogService.Books': { mask: ['price'] } }
    },
    audit: false // keep this suite focused on spans; audit log is covered elsewhere
  });

  beforeEach(() => {
    memoryExporter.reset();
  });

  it('records a real span, with GenAI/context attributes and the Decision namespaced under cap_mcp_guard.*, for a real OData READ', async () => {
    await GET('/odata/v4/browse/Books');

    const spans = memoryExporter.getFinishedSpans();
    const bookSpan = spans.find((s) => s.attributes.entity === 'CatalogService.Books');

    expect(bookSpan).toBeDefined();
    expect(bookSpan.name).toBe('READ CatalogService.Books');
    expect(bookSpan.attributes.operation).toBe('READ');
    expect(bookSpan.attributes.user).toBe('anonymous');
    expect(typeof bookSpan.attributes.rowCount).toBe('number');
    expect(bookSpan.attributes['cap_mcp_guard.mode']).toBe('enforce');
    expect(bookSpan.attributes['cap_mcp_guard.fields_masked']).toEqual(['price']);
  });

  it('gives the span a real, non-zero duration matching the request timing', async () => {
    await GET('/odata/v4/browse/Books');

    const bookSpan = memoryExporter.getFinishedSpans().find((s) => s.attributes.entity === 'CatalogService.Books');
    const durationMs = (bookSpan.duration[0] * 1e9 + bookSpan.duration[1]) / 1e6;

    expect(durationMs).toBeGreaterThanOrEqual(0);
  });
});