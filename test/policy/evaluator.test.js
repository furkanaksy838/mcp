'use strict';

const { evaluate } = require('../../lib/policy/evaluator');

function ctx(overrides = {}) {
  return {
    entity: 'Orders',
    operation: 'READ',
    rowCount: 10,
    timestamp: '2026-07-18T00:00:00.000Z',
    ...overrides
  };
}

function policy(mode, entities = {}) {
  return { mode, entities };
}

function passThroughShape(mode, context) {
  return {
    mode,
    allowed: true,
    reason: null,
    fieldsToMask: [],
    fieldsToPseudonymize: [],
    rowLimitExceeded: false,
    maxRows: null,
    entity: context.entity,
    timestamp: context.timestamp
  };
}

describe('evaluate', () => {
  test('entity not mentioned in policyDefinition.entities is fully allowed', () => {
    const decision = evaluate(ctx({ entity: 'Books' }), policy('enforce', {}));

    expect(decision).toEqual({
      mode: 'enforce',
      allowed: true,
      reason: null,
      fieldsToMask: [],
      fieldsToPseudonymize: [],
      rowLimitExceeded: false,
      maxRows: null,
      entity: 'Books',
      timestamp: '2026-07-18T00:00:00.000Z'
    });
  });

  test('completely empty entities ({}) allows every request', () => {
    const decision = evaluate(ctx({ entity: 'Anything' }), policy('observe', {}));
    expect(decision.allowed).toBe(true);
    expect(decision.fieldsToMask).toEqual([]);
    expect(decision.rowLimitExceeded).toBe(false);
  });

  describe('allowTools', () => {
    test('operation present in allowTools -> allowed', () => {
      const decision = evaluate(
        ctx({ operation: 'ReadOrders' }),
        policy('enforce', { Orders: { allowTools: ['ReadOrders'] } })
      );
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBeNull();
    });

    test('operation absent from allowTools -> not allowed, with reason', () => {
      const decision = evaluate(
        ctx({ operation: 'DeleteOrder' }),
        policy('enforce', { Orders: { allowTools: ['ReadOrders'] } })
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("tool 'DeleteOrder' not in allowTools for entity 'Orders'");
    });

    test('allowTools not defined -> allowed regardless of operation', () => {
      const decision = evaluate(ctx({ operation: 'DeleteOrder' }), policy('enforce', { Orders: { mask: ['Salary'] } }));
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBeNull();
    });
  });

  describe('maxRows / rowLimitExceeded', () => {
    test('rowCount under maxRows -> rowLimitExceeded false', () => {
      const decision = evaluate(ctx({ rowCount: 5 }), policy('enforce', { Orders: { maxRows: 100 } }));
      expect(decision.rowLimitExceeded).toBe(false);
      expect(decision.maxRows).toBe(100);
    });

    test('rowCount over maxRows -> rowLimitExceeded true, but allowed stays true', () => {
      const decision = evaluate(ctx({ rowCount: 500 }), policy('enforce', { Orders: { maxRows: 100 } }));
      expect(decision.rowLimitExceeded).toBe(true);
      expect(decision.allowed).toBe(true);
      expect(decision.maxRows).toBe(100);
    });

    test('rowLimitExceeded never overrides an allowTools rejection', () => {
      const decision = evaluate(
        ctx({ operation: 'DeleteOrder', rowCount: 500 }),
        policy('enforce', { Orders: { allowTools: ['ReadOrders'], maxRows: 100 } })
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rowLimitExceeded).toBe(true);
    });

    test('maxRows not defined -> rowLimitExceeded always false, maxRows null', () => {
      const decision = evaluate(ctx({ rowCount: 999999 }), policy('enforce', { Orders: { mask: ['Salary'] } }));
      expect(decision.rowLimitExceeded).toBe(false);
      expect(decision.maxRows).toBeNull();
    });
  });

  describe('fieldsToMask', () => {
    test('mask defined -> fieldsToMask is that array', () => {
      const decision = evaluate(ctx(), policy('enforce', { Orders: { mask: ['CreditCard', 'Salary'] } }));
      expect(decision.fieldsToMask).toEqual(['CreditCard', 'Salary']);
    });

    test('mask not defined -> fieldsToMask is [] (not undefined)', () => {
      const decision = evaluate(ctx(), policy('enforce', { Orders: { maxRows: 10 } }));
      expect(decision.fieldsToMask).toEqual([]);
      expect(decision.fieldsToMask).not.toBeUndefined();
    });
  });

  describe('mode passthrough', () => {
    test('mode is carried over from policyDefinition unchanged, in both enforce and observe', () => {
      expect(evaluate(ctx(), policy('enforce', {})).mode).toBe('enforce');
      expect(evaluate(ctx(), policy('observe', {})).mode).toBe('observe');
    });

    test('observe mode computes the exact same decision fields as enforce would', () => {
      const entities = { Orders: { allowTools: ['ReadOrders'], maxRows: 1, mask: ['Salary'] } };
      const enforceDecision = evaluate(ctx({ operation: 'DeleteOrder', rowCount: 50 }), policy('enforce', entities));
      const observeDecision = evaluate(ctx({ operation: 'DeleteOrder', rowCount: 50 }), policy('observe', entities));

      expect(observeDecision).toEqual({ ...enforceDecision, mode: 'observe' });
    });
  });

  test('entity and timestamp are carried over verbatim from context', () => {
    const decision = evaluate(ctx({ entity: 'Genres', timestamp: '2020-01-01T00:00:00.000Z' }), policy('enforce', {}));
    expect(decision.entity).toBe('Genres');
    expect(decision.timestamp).toBe('2020-01-01T00:00:00.000Z');
  });

  describe('users allowlist', () => {
    const entities = { Orders: { mask: ['CreditCard'], allowTools: ['ReadOrders'], maxRows: 1 } };

    test('a user not in "users" is fully passed through — no masking, no allowTools/maxRows enforcement', () => {
      const context = ctx({ user: 'alice@example.com', operation: 'DeleteOrder', rowCount: 999 });
      const decision = evaluate(context, { mode: 'enforce', entities, users: ['mcp-agent-technical-user'] });

      expect(decision).toEqual(passThroughShape('enforce', context));
    });

    test('a user in "users" gets the entity policy applied normally', () => {
      const context = ctx({ user: 'mcp-agent-technical-user' });
      const decision = evaluate(context, { mode: 'enforce', entities, users: ['mcp-agent-technical-user'] });

      expect(decision.fieldsToMask).toEqual(['CreditCard']);
    });

    test('omitting "users" enforces the policy for every requester, as before', () => {
      const context = ctx({ user: 'alice@example.com' });
      const decision = evaluate(context, { mode: 'enforce', entities });

      expect(decision.fieldsToMask).toEqual(['CreditCard']);
    });

    test('a request with no context.user is passed through when "users" is set', () => {
      const context = ctx({ user: undefined });
      const decision = evaluate(context, { mode: 'enforce', entities, users: ['mcp-agent-technical-user'] });

      expect(decision).toEqual(passThroughShape('enforce', context));
    });
  });

  describe('fieldsToPseudonymize', () => {
    test('pseudonymize defined -> fieldsToPseudonymize is that array', () => {
      const decision = evaluate(
        ctx(),
        policy('enforce', { Orders: { pseudonymize: [{ field: 'IBAN', type: 'iban' }] } })
      );
      expect(decision.fieldsToPseudonymize).toEqual([{ field: 'IBAN', type: 'iban' }]);
    });

    test('pseudonymize not defined -> fieldsToPseudonymize is [] (not undefined)', () => {
      const decision = evaluate(ctx(), policy('enforce', { Orders: { mask: ['Salary'] } }));
      expect(decision.fieldsToPseudonymize).toEqual([]);
      expect(decision.fieldsToPseudonymize).not.toBeUndefined();
    });

    test('mask and pseudonymize can be used together on the same entity', () => {
      const decision = evaluate(
        ctx(),
        policy('enforce', {
          Orders: { mask: ['CreditCard'], pseudonymize: [{ field: 'IBAN', type: 'iban' }] }
        })
      );
      expect(decision.fieldsToMask).toEqual(['CreditCard']);
      expect(decision.fieldsToPseudonymize).toEqual([{ field: 'IBAN', type: 'iban' }]);
    });
  });
});