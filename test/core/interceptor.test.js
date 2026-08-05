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

    test('onDecision is called with the Decision, the Context it came from, and req', async () => {
      const srv = createFakeService();
      const onDecision = jest.fn();
      attachInterceptor(srv, { policyDefinition, onDecision });

      const req = { event: 'READ', entity: 'Orders' };
      const results = [{ ID: 1, CreditCard: '4111-...' }];
      await srv.simulateRequest(req, results);

      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'enforce', allowed: true, fieldsToMask: ['CreditCard'], entity: 'Orders' }),
        expect.objectContaining({ entity: 'Orders', operation: 'READ' }),
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

  describe('enforcement beyond masking (allowTools, maxRows, nested associations)', () => {
    test('enforce mode calls req.reject() when the operation is not in allowTools, before the query runs', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        entities: { Orders: { allowTools: ['NEVER_MATCHES'] } }
      };
      const onDecision = jest.fn();
      attachInterceptor(srv, { policyDefinition, onDecision });

      // real cds.Request#reject() throws, which is what actually stops the request
      // before the query runs and srv.after('*') never fires for it
      const reject = jest.fn((code, message) => {
        throw Object.assign(new Error(message), { code });
      });
      const req = { event: 'READ', entity: 'Orders', reject };
      const results = [{ ID: 1 }];

      await expect(srv.simulateRequest(req, results)).rejects.toThrow(/allowTools/);

      expect(reject).toHaveBeenCalledWith(403, expect.stringContaining('allowTools'));
      // results untouched: the after handler never ran because reject() short-circuits
      expect(results).toEqual([{ ID: 1 }]);
      // still audited, even though the request was denied and after() never fired
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision.mock.calls[0][0].allowed).toBe(false);
    });

    test('throws when denied and req.reject is not a function (non-CAP callers)', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        entities: { Orders: { allowTools: ['NEVER_MATCHES'] } }
      };
      attachInterceptor(srv, { policyDefinition });

      await expect(
        srv.simulateRequest({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }])
      ).rejects.toThrow(/allowTools/);
    });

    test('observe mode never rejects even when allowTools would deny', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'observe',
        entities: { Orders: { allowTools: ['NEVER_MATCHES'] } }
      };
      const req = { event: 'READ', entity: 'Orders', reject: jest.fn() };

      attachInterceptor(srv, { policyDefinition });
      await expect(srv.simulateRequest(req, [{ ID: 1 }])).resolves.toBeUndefined();
      expect(req.reject).not.toHaveBeenCalled();
    });

    test('enforce mode truncates results in place when maxRows is exceeded', async () => {
      const srv = createFakeService();
      const policyDefinition = { mode: 'enforce', entities: { Orders: { maxRows: 1 } } };
      attachInterceptor(srv, { policyDefinition });

      const results = [{ ID: 1 }, { ID: 2 }, { ID: 3 }];
      await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, results);

      expect(results).toEqual([{ ID: 1 }]);
    });

    test('does not truncate when maxRows is not exceeded', async () => {
      const srv = createFakeService();
      const policyDefinition = { mode: 'enforce', entities: { Orders: { maxRows: 5 } } };
      attachInterceptor(srv, { policyDefinition });

      const results = [{ ID: 1 }, { ID: 2 }];
      await srv.simulateRequest({ event: 'READ', entity: 'Orders' }, results);

      expect(results).toEqual([{ ID: 1 }, { ID: 2 }]);
    });

    test('applies the target entity policy to an expanded association, one level deep', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        entities: {
          Employees: { mask: ['salary'] },
          Departments: { mask: ['budget'] }
        }
      };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: {
          elements: {
            department: { type: 'cds.Association', target: 'Departments' },
            name: { type: 'cds.String' }
          }
        }
      };
      const results = [
        { ID: 1, salary: 85000, department: { ID: 1, budget: 2500000 } },
        { ID: 2, salary: 95000, department: { ID: 2, budget: 800000 } }
      ];

      await srv.simulateRequest(req, results);

      expect(results).toEqual([
        { ID: 1, salary: '***MASKED***', department: { ID: 1, budget: '***MASKED***' } },
        { ID: 2, salary: '***MASKED***', department: { ID: 2, budget: '***MASKED***' } }
      ]);
    });

    test('leaves the nav property untouched when the target entity has no policy configured', async () => {
      const srv = createFakeService();
      const policyDefinition = { mode: 'enforce', entities: { Employees: { mask: ['salary'] } } };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, salary: 85000, department: { ID: 1, budget: 2500000 } }];

      await srv.simulateRequest(req, results);

      expect(results[0].department).toEqual({ ID: 1, budget: 2500000 });
    });

    // Regression, found running 0.6.0 against a real CAP project: nested rows used to read
    // policyDefinition.entities directly, so "users" scoping never reached them. A human user
    // outside the list got a correctly unmasked top level and masked expanded rows — the same
    // field readable directly but '***MASKED***' inside $expand.
    test('honours "users" scoping for expanded rows: an identity outside the list gets them unmasked', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        users: ['mcp-agent'],
        entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget'] } }
      };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        user: { id: 'fiori-user' },
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, salary: 85000, department: { ID: 1, budget: 2500000 } }];

      await srv.simulateRequest(req, results);

      expect(results[0].salary).toBe(85000);
      expect(results[0].department).toEqual({ ID: 1, budget: 2500000 });
    });

    test('still masks expanded rows for an identity that is in the "users" list', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        users: ['mcp-agent'],
        entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget'] } }
      };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        user: { id: 'mcp-agent' },
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, salary: 85000, department: { ID: 1, budget: 2500000 } }];

      await srv.simulateRequest(req, results);

      expect(results[0].salary).toBe('***MASKED***');
      expect(results[0].department).toEqual({ ID: 1, budget: '***MASKED***' });
    });

    test('masks expanded rows even when the requested entity has no policy of its own', async () => {
      const srv = createFakeService();
      const policyDefinition = { mode: 'enforce', entities: { Departments: { mask: ['budget'] } } };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, salary: 85000, department: { ID: 1, budget: 2500000 } }];

      await srv.simulateRequest(req, results);

      expect(results[0].salary).toBe(85000);
      expect(results[0].department).toEqual({ ID: 1, budget: '***MASKED***' });
    });

    test('observe mode leaves expanded rows untouched', async () => {
      const srv = createFakeService();
      const policyDefinition = { mode: 'observe', entities: { Departments: { mask: ['budget'] } } };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, department: { ID: 1, budget: 2500000 } }];

      await srv.simulateRequest(req, results);

      expect(results[0].department).toEqual({ ID: 1, budget: 2500000 });
    });

    test('does nothing when the association was not expanded (nav property absent)', async () => {
      const srv = createFakeService();
      const policyDefinition = {
        mode: 'enforce',
        entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget'] } }
      };
      attachInterceptor(srv, { policyDefinition });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: { elements: { department: { type: 'cds.Association', target: 'Departments' } } }
      };
      const results = [{ ID: 1, salary: 85000, department_ID: 1 }];

      await expect(srv.simulateRequest(req, results)).resolves.toBeUndefined();
      expect(results).toEqual([{ ID: 1, salary: '***MASKED***', department_ID: 1 }]);
    });
  });

  // A field has exactly one type — the one the service publishes — so '***MASKED***' can only go
  // into a string field. Anywhere else the response would contradict its own $metadata and typed
  // consumers can't render it: Fiori Elements shows an empty cell, which reads as "no value"
  // rather than "withheld". Non-string fields are masked to null instead.
  describe('type-aware mask values', () => {
    async function read(elements, row) {
      const srv = createFakeService();
      attachInterceptor(srv, {
        policyDefinition: { mode: 'enforce', entities: { Employees: { mask: Object.keys(row).filter((k) => k !== 'ID') } } }
      });
      const results = [row];
      await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: { elements } }, results);
      return results[0];
    }

    test('uses the placeholder for a string field', async () => {
      const row = await read({ nationalId: { type: 'cds.String' } }, { ID: 1, nationalId: '12345678901' });
      expect(row.nationalId).toBe('***MASKED***');
    });

    test('uses the placeholder for a large string field', async () => {
      const row = await read({ notes: { type: 'cds.LargeString' } }, { ID: 1, notes: 'a long note' });
      expect(row.notes).toBe('***MASKED***');
    });

    test('masks a decimal to null rather than a string the type cannot hold', async () => {
      const row = await read({ salary: { type: 'cds.Decimal' } }, { ID: 1, salary: 85000 });
      expect(row.salary).toBeNull();
    });

    test('masks integer, boolean, date and timestamp fields to null too', async () => {
      const row = await read(
        {
          headcount: { type: 'cds.Integer' },
          active: { type: 'cds.Boolean' },
          hiredOn: { type: 'cds.Date' },
          changedAt: { type: 'cds.Timestamp' }
        },
        { ID: 1, headcount: 12, active: true, hiredOn: '2020-01-01', changedAt: '2020-01-01T00:00:00Z' }
      );
      expect(row.headcount).toBeNull();
      expect(row.active).toBeNull();
      expect(row.hiredOn).toBeNull();
      expect(row.changedAt).toBeNull();
    });

    // cds.UUID is a string in JS but surfaces as Edm.Guid, and the placeholder is not a GUID.
    test('masks a UUID to null, since the placeholder is not a valid GUID', async () => {
      const row = await read({ ref: { type: 'cds.UUID' } }, { ID: 1, ref: '11111111-2222-3333-4444-555555555555' });
      expect(row.ref).toBeNull();
    });

    test('mixes both in one row, per field', async () => {
      const row = await read(
        { name: { type: 'cds.String' }, salary: { type: 'cds.Decimal' } },
        { ID: 1, name: 'Ahmet', salary: 85000 }
      );
      expect(row.name).toBe('***MASKED***');
      expect(row.salary).toBeNull();
    });

    test('falls back to the placeholder when the request carries no elements to type against', async () => {
      const srv = createFakeService();
      attachInterceptor(srv, { policyDefinition: { mode: 'enforce', entities: { Employees: { mask: ['salary'] } } } });
      const results = [{ ID: 1, salary: 85000 }];

      await srv.simulateRequest({ event: 'READ', entity: 'Employees' }, results);

      expect(results[0].salary).toBe('***MASKED***');
    });

    test('applies the same rule to expanded rows, using the association target\'s elements', async () => {
      const srv = createFakeService();
      attachInterceptor(srv, {
        policyDefinition: {
          mode: 'enforce',
          entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget', 'code'] } }
        }
      });

      const req = {
        event: 'READ',
        entity: 'Employees',
        target: {
          elements: {
            salary: { type: 'cds.Decimal' },
            department: {
              type: 'cds.Association',
              _target: {
                name: 'Departments',
                elements: { budget: { type: 'cds.Decimal' }, code: { type: 'cds.String' } }
              }
            }
          }
        }
      };
      const results = [{ ID: 1, salary: 85000, department: { ID: 1, budget: 2500000, code: 'ENG' } }];

      await srv.simulateRequest(req, results);

      expect(results[0].salary).toBeNull();
      expect(results[0].department.budget).toBeNull();
      expect(results[0].department.code).toBe('***MASKED***');
    });
  });

  describe('pseudonymize', () => {
    const SECRET = 'test-secret';

    async function readRows(entities, rows, entity = 'Employees') {
      const srv = createFakeService();
      attachInterceptor(srv, {
        policyDefinition: { mode: 'enforce', entities },
        pseudonymSecret: SECRET
      });
      const results = rows;
      await srv.simulateRequest({ event: 'READ', entity }, results);
      return results;
    }

    test('replaces the value with a deterministic pseudonym on the real response', async () => {
      const [row] = await readRows({ Employees: { pseudonymize: [{ field: 'syd', type: 'opaque' }] } }, [
        { ID: 1, syd: 'Yilmaz' }
      ]);

      expect(row.syd).not.toBe('Yilmaz');
      expect(row.syd).toMatch(/^syd-[0-9a-f]{12}$/);
    });

    test('leaves the field alone when the row does not carry it', async () => {
      const [row] = await readRows({ Employees: { pseudonymize: [{ field: 'syd', type: 'opaque' }] } }, [{ ID: 1 }]);

      expect(row).toEqual({ ID: 1 });
    });

    // The wiring this covers: `group` has to travel policy -> Decision -> generatePseudonym.
    // Dropping it anywhere in that chain silently falls back to per-field namespacing, which
    // looks fine in isolation and only shows up as two entities disagreeing about one value.
    test('a shared group yields the same pseudonym for the same value across differently-named fields', async () => {
      const [employee] = await readRows(
        { Employees: { pseudonymize: [{ field: 'syd', type: 'opaque', group: 'surname' }] } },
        [{ ID: 1, syd: 'Yilmaz' }]
      );
      const [customer] = await readRows(
        { Customers: { pseudonymize: [{ field: 'soyad', type: 'opaque', group: 'surname' }] } },
        [{ ID: 9, soyad: 'Yilmaz' }],
        'Customers'
      );

      expect(employee.syd).toBe(customer.soyad);
      expect(employee.syd).toMatch(/^surname-[0-9a-f]{12}$/);
    });

    test('without a group those same two fields disagree, as documented', async () => {
      const [employee] = await readRows({ Employees: { pseudonymize: [{ field: 'syd', type: 'opaque' }] } }, [
        { ID: 1, syd: 'Yilmaz' }
      ]);
      const [customer] = await readRows(
        { Customers: { pseudonymize: [{ field: 'soyad', type: 'opaque' }] } },
        [{ ID: 9, soyad: 'Yilmaz' }],
        'Customers'
      );

      expect(employee.syd).not.toBe(customer.soyad);
    });

    test('observe mode computes the pseudonym but never touches the response', async () => {
      const srv = createFakeService();
      attachInterceptor(srv, {
        policyDefinition: {
          mode: 'observe',
          entities: { Employees: { pseudonymize: [{ field: 'syd', type: 'opaque', group: 'surname' }] } }
        },
        pseudonymSecret: SECRET
      });

      const results = [{ ID: 1, syd: 'Yilmaz' }];
      await srv.simulateRequest({ event: 'READ', entity: 'Employees' }, results);

      expect(results).toEqual([{ ID: 1, syd: 'Yilmaz' }]);
    });
  });
});