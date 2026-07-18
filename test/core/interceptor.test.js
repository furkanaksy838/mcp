'use strict';

const { attachInterceptor } = require('../../lib/core/interceptor');

/** Minimal duck-typed stand-in for a CAP service — no @sap/cds involved. */
function createFakeService() {
  const beforeHandlers = [];
  const afterHandlers = [];

  return {
    before(event, handler) {
      beforeHandlers.push(handler);
    },
    after(event, handler) {
      afterHandlers.push(handler);
    },
    async simulateRequest(req, results) {
      for (const handler of beforeHandlers) await handler(req);
      for (const handler of afterHandlers) await handler(results, req);
    }
  };
}

describe('attachInterceptor', () => {
  test('throws when given something that is not a CAP-shaped service', () => {
    expect(() => attachInterceptor({})).toThrow(/before\(\)\/after\(\)/);
    expect(() => attachInterceptor(null)).toThrow();
  });

  test('builds a context and reports it via onContext after the request completes', async () => {
    const srv = createFakeService();
    const onContext = jest.fn();

    attachInterceptor(srv, { onContext, now: () => 'FIXED_TIMESTAMP' });

    const req = {
      event: 'READ',
      entity: 'Orders',
      tenant: 'tenant-1',
      user: { id: 'alice' },
      id: 'session-1'
    };

    await srv.simulateRequest(req, [{ ID: 1 }, { ID: 2 }]);

    expect(onContext).toHaveBeenCalledTimes(1);
    const [context, passedReq] = onContext.mock.calls[0];

    expect(passedReq).toBe(req);
    expect(context.entity).toBe('Orders');
    expect(context.operation).toBe('READ');
    expect(context.tenant).toBe('tenant-1');
    expect(context.user).toBe('alice');
    expect(context.session).toBe('session-1');
    expect(context.rowCount).toBe(2);
    expect(context.timestamp).toBe('FIXED_TIMESTAMP');
    expect(typeof context.durationMs).toBe('number');
    expect(context.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('falls back to req.target.name when req.entity is absent', async () => {
    const srv = createFakeService();
    const onContext = jest.fn();
    attachInterceptor(srv, { onContext });

    const req = { event: 'READ', target: { name: 'Books' } };
    await srv.simulateRequest(req, []);

    expect(onContext.mock.calls[0][0].entity).toBe('Books');
  });

  test('extracts gen_ai.* agent info and W3C trace context from req._meta', async () => {
    const srv = createFakeService();
    const onContext = jest.fn();
    attachInterceptor(srv, { onContext });

    const req = {
      event: 'READ',
      entity: 'Orders',
      _meta: {
        'gen_ai.agent.id': 'agent-123',
        'gen_ai.agent.name': 'Claude Desktop',
        'gen_ai.request.model': 'claude-sonnet-5',
        traceparent: '00-abc-def-01',
        tracestate: 'vendor=value'
      }
    };

    await srv.simulateRequest(req, {});

    const context = onContext.mock.calls[0][0];
    expect(context['gen_ai.agent.id']).toBe('agent-123');
    expect(context['gen_ai.agent.name']).toBe('Claude Desktop');
    expect(context['gen_ai.request.model']).toBe('claude-sonnet-5');
    expect(context.traceparent).toBe('00-abc-def-01');
    expect(context.tracestate).toBe('vendor=value');
  });

  test('rowCount reflects array length, single-object reads, and empty results', async () => {
    const srv = createFakeService();
    const seen = [];
    attachInterceptor(srv, { onContext: (context) => seen.push(context.rowCount) });

    await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, [1, 2, 3]);
    await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, { ID: 1 });
    await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, undefined);
    await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, null);

    expect(seen).toEqual([3, 1, 0, 0]);
  });

  test('does not throw and still reports context when req has no _meta/http/user', async () => {
    const srv = createFakeService();
    const onContext = jest.fn();
    attachInterceptor(srv, { onContext });

    await expect(srv.simulateRequest({ event: 'DELETE', entity: 'Orders' }, [])).resolves.not.toThrow();
    expect(onContext).toHaveBeenCalledTimes(1);
  });

  test('never invokes onContext when it is not a function', async () => {
    const srv = createFakeService();
    attachInterceptor(srv, {});
    await expect(srv.simulateRequest({ event: 'READ' }, [])).resolves.toBeUndefined();
  });

  describe('with a policyDefinition (M4 wiring)', () => {
    const policyDefinition = {
      mode: 'enforce',
      entities: { Orders: { mask: ['CreditCard'] } }
    };

    test('enforce mode masks the fields named in the Decision, on the real response', async () => {
      const srv = createFakeService();
      attachInterceptor(srv, { policyDefinition });

      const results = [{ ID: 1, CreditCard: '4111-...' }, { ID: 2, CreditCard: '5500-...' }];
      await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, results);

      expect(results).toEqual([
        { ID: 1, CreditCard: '***MASKED***' },
        { ID: 2, CreditCard: '***MASKED***' }
      ]);
    });

    test('observe mode computes a Decision but never touches the response', async () => {
      const srv = createFakeService();
      const onDecision = jest.fn();
      attachInterceptor(srv, { policyDefinition: { ...policyDefinition, mode: 'observe' }, onDecision });

      const results = [{ ID: 1, CreditCard: '4111-...' }];
      await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, results);

      expect(results).toEqual([{ ID: 1, CreditCard: '4111-...' }]);
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision.mock.calls[0][0].mode).toBe('observe');
      expect(onDecision.mock.calls[0][0].fieldsToMask).toEqual(['CreditCard']);
    });

    test('onDecision is called with the Decision in both enforce and observe mode', async () => {
      const srv = createFakeService();
      const onDecision = jest.fn();
      attachInterceptor(srv, { policyDefinition, onDecision });

      const req = { event: 'READ', entity: 'Orders' };
      const results = [{ ID: 1, CreditCard: '4111-...' }];
      await srv.simulateRequest(req, results);

      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'enforce', allowed: true, fieldsToMask: ['CreditCard'], entity: 'Orders' }),
        req
      );
    });

    test('entity not covered by the policy is left completely untouched', async () => {
      const srv = createFakeService();
      const onDecision = jest.fn();
      attachInterceptor(srv, { policyDefinition, onDecision });

      const results = [{ ID: 1, CreditCard: '4111-...' }];
      await srv.simulateRequest({ event: 'READ', entity: 'Books' }, results);

      expect(results).toEqual([{ ID: 1, CreditCard: '4111-...' }]);
      expect(onDecision.mock.calls[0][0].fieldsToMask).toEqual([]);
    });

    test('does not evaluate policy or call onDecision when no policyDefinition is given', async () => {
      const srv = createFakeService();
      const onDecision = jest.fn();
      attachInterceptor(srv, { onDecision });

      await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, [{ ID: 1, CreditCard: '4111-...' }]);

      expect(onDecision).not.toHaveBeenCalled();
    });

    test('never throws when onDecision is not a function', async () => {
      const srv = createFakeService();
      attachInterceptor(srv, { policyDefinition });

      await expect(
        srv.simulateRequest({ event: 'READ', entity: 'Orders' }, [{ ID: 1, CreditCard: 'x' }])
      ).resolves.toBeUndefined();
    });
  });
});