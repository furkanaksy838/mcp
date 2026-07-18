'use strict';

const { buildContext } = require('../../lib/core/context');

describe('buildContext', () => {
  test('maps input fields onto the gen_ai.* / trace-context / business schema', () => {
    const context = buildContext({
      agentId: 'agent-123',
      agentName: 'Claude Desktop',
      model: 'claude-sonnet-5',
      traceparent: '00-abc-def-01',
      tracestate: 'vendor=value',
      entity: 'Orders',
      operation: 'READ',
      tenant: 't1',
      user: 'alice',
      session: 'sess-1',
      timestamp: '2026-07-18T00:00:00.000Z',
      rowCount: 42,
      durationMs: 12.5
    });

    expect(context).toEqual({
      'gen_ai.agent.id': 'agent-123',
      'gen_ai.agent.name': 'Claude Desktop',
      'gen_ai.request.model': 'claude-sonnet-5',
      traceparent: '00-abc-def-01',
      tracestate: 'vendor=value',
      entity: 'Orders',
      operation: 'READ',
      tenant: 't1',
      user: 'alice',
      session: 'sess-1',
      timestamp: '2026-07-18T00:00:00.000Z',
      rowCount: 42,
      durationMs: 12.5
    });
  });

  test('is pure: identical input + injected clock always produce identical output', () => {
    const input = { entity: 'Books', operation: 'READ' };
    const deps = { now: () => 'FIXED_TIMESTAMP' };

    expect(buildContext(input, deps)).toEqual(buildContext(input, deps));
    expect(buildContext(input, deps).timestamp).toBe('FIXED_TIMESTAMP');
  });

  test('defaults timestamp to an ISO string when not provided and no clock injected', () => {
    const context = buildContext({ entity: 'Books' });
    expect(() => new Date(context.timestamp).toISOString()).not.toThrow();
    expect(new Date(context.timestamp).toISOString()).toBe(context.timestamp);
  });

  test('leaves unset optional fields as undefined rather than inventing values', () => {
    const context = buildContext({}, { now: () => 'FIXED_TIMESTAMP' });

    expect(context['gen_ai.agent.id']).toBeUndefined();
    expect(context['gen_ai.agent.name']).toBeUndefined();
    expect(context['gen_ai.request.model']).toBeUndefined();
    expect(context.traceparent).toBeUndefined();
    expect(context.tracestate).toBeUndefined();
    expect(context.entity).toBeUndefined();
    expect(context.operation).toBeUndefined();
    expect(context.tenant).toBeUndefined();
    expect(context.user).toBeUndefined();
    expect(context.session).toBeUndefined();
    expect(context.rowCount).toBeUndefined();
    expect(context.durationMs).toBeUndefined();
    expect(context.timestamp).toBe('FIXED_TIMESTAMP');
  });

  test('treats 0 as a valid rowCount/durationMs, not "unset"', () => {
    const context = buildContext({ rowCount: 0, durationMs: 0 });
    expect(context.rowCount).toBe(0);
    expect(context.durationMs).toBe(0);
  });

  test('defaults missing input to {} without throwing', () => {
    expect(() => buildContext()).not.toThrow();
  });
});