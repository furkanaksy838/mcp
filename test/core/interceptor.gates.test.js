'use strict';

const { attachInterceptor } = require('../../lib/core/interceptor');

/**
 * The three gates that have to run *before* the query does, plus the row limit that has to reach
 * the database rather than only the response. None of these are fixable in an `after` hook: a
 * filtered, sorted or aggregated result has already disclosed what it discloses by the time rows
 * come back, an accepted write has already been accepted, and a truncated response was still paid
 * for in full.
 */

/** Minimal duck-typed stand-in for a CAP service — no @sap/cds involved. */
function createFakeService() {
  const before = [];
  const after = [];

  return {
    before(event, handler) {
      before.push(handler);
    },
    after(event, handler) {
      after.push(handler);
    },
    async simulateRequest(req, results) {
      for (const handler of before) await handler(req);
      for (const handler of after) await handler(results, req);
    }
  };
}

const PROTECTED = {
  mode: 'enforce',
  entities: { Employees: { mask: ['salary'], pseudonymize: [{ field: 'iban', type: 'opaque' }] } }
};

function rejectingRequest(fields) {
  return {
    entity: 'Employees',
    reject(code, reason) {
      this.rejectedWith = { code, reason };
      throw new Error(reason);
    },
    ...fields
  };
}

describe('query-side protection', () => {
  function read(query, mode = 'enforce') {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: { ...PROTECTED, mode }, pseudonymSecret: 'secret' });
    return { srv, req: rejectingRequest({ event: 'READ', query }) };
  }

  test('rejects a $filter over a masked field', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Employees'] }, where: [{ ref: ['salary'] }, '>', { val: 100000 }] }
    });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/protected field\(s\) 'salary'/);
    expect(req.rejectedWith.code).toBe(403);
  });

  test('rejects an $orderby over a pseudonymized field', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Employees'] }, orderBy: [{ ref: ['iban'], sort: 'desc' }] }
    });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/protected field\(s\) 'iban'/);
  });

  test('rejects an aggregate over a masked field', async () => {
    const { srv, req } = read({
      SELECT: {
        from: { ref: ['Employees'] },
        columns: [{ func: 'sum', args: [{ ref: ['salary'] }], as: 'total' }]
      }
    });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/protected field\(s\) 'salary'/);
  });

  test('rejects a $groupby over a masked field', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Employees'] }, groupBy: [{ ref: ['salary'] }] } });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/'salary'/);
  });

  test('rejects a having clause over a masked field', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Employees'] }, having: [{ ref: ['salary'] }, '>', { val: 1 }] }
    });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/'salary'/);
  });

  test('rejects a protected field buried in a nested expression', async () => {
    const { srv, req } = read({
      SELECT: {
        from: { ref: ['Employees'] },
        where: [{ xpr: [{ ref: ['salary'] }, '*', { val: 2 }] }, '>', { val: 10 }]
      }
    });

    await expect(srv.simulateRequest(req, [])).rejects.toThrow(/'salary'/);
  });

  // Selecting the field is the normal case and stays allowed — that is what masking is for. Only
  // computing over it is refused.
  test('allows plainly selecting a protected field, and masks it as usual', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Employees'] }, columns: [{ ref: ['ID'] }, { ref: ['salary'] }] }
    });
    const results = [{ ID: 1, salary: 85000 }];

    await srv.simulateRequest(req, results);

    expect(results[0].salary).toBe('***MASKED***');
  });

  test('allows filtering over an unprotected field', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Employees'] }, where: [{ ref: ['role'] }, '=', { val: 'Developer' }] }
    });

    await expect(srv.simulateRequest(req, [{ ID: 1 }])).resolves.toBeUndefined();
  });

  test('allows a request with no query at all', async () => {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: PROTECTED, pseudonymSecret: 'secret' });

    await expect(srv.simulateRequest({ event: 'READ', entity: 'Employees' }, [])).resolves.toBeUndefined();
  });

  test('observe mode reports the violation without blocking', async () => {
    const srv = createFakeService();
    const decisions = [];
    attachInterceptor(srv, {
      policyDefinition: { ...PROTECTED, mode: 'observe' },
      onDecision: (d) => decisions.push(d),
      pseudonymSecret: 'secret'
    });
    const results = [{ ID: 1, salary: 85000 }];

    await srv.simulateRequest(
      {
        event: 'READ',
        entity: 'Employees',
        query: { SELECT: { from: { ref: ['Employees'] }, where: [{ ref: ['salary'] }, '>', { val: 1 }] } }
      },
      results
    );

    expect(decisions.some((d) => d.allowed === false && /protected field/.test(d.reason || ''))).toBe(true);
    expect(results[0].salary).toBe(85000);
  });
});

describe('write protection', () => {
  function write(event, data) {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: PROTECTED, pseudonymSecret: 'secret' });
    return { srv, req: rejectingRequest({ event, data }) };
  }

  // Reading a field masked and writing it back replaces the real value with the placeholder — or
  // with a pseudonym plausible enough that nobody notices.
  test('rejects an UPDATE carrying a masked field', async () => {
    const { srv, req } = write('UPDATE', { salary: '***MASKED***' });

    await expect(srv.simulateRequest(req, {})).rejects.toThrow(/write targets protected field\(s\) 'salary'/);
  });

  test('rejects a CREATE carrying a pseudonymized field', async () => {
    const { srv, req } = write('CREATE', { ID: 9, iban: 'iban-abc123' });

    await expect(srv.simulateRequest(req, {})).rejects.toThrow(/'iban'/);
  });

  test('rejects a bulk write where only one row carries a protected field', async () => {
    const { srv, req } = write('UPDATE', [{ role: 'Dev' }, { salary: 1 }]);

    await expect(srv.simulateRequest(req, {})).rejects.toThrow(/'salary'/);
  });

  test('allows a write touching only unprotected fields', async () => {
    const { srv, req } = write('UPDATE', { role: 'Senior Developer' });

    await expect(srv.simulateRequest(req, {})).resolves.toBeUndefined();
  });

  test('does not mistake a READ payload for a write', async () => {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: PROTECTED, pseudonymSecret: 'secret' });

    await expect(
      srv.simulateRequest({ event: 'READ', entity: 'Employees', data: { salary: 1 } }, [{ ID: 1 }])
    ).resolves.toBeUndefined();
  });
});

describe('maxRows reaches the query', () => {
  const LIMITED = { mode: 'enforce', entities: { Orders: { maxRows: 100 } } };

  function read(query, mode = 'enforce') {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: { ...LIMITED, mode } });
    return { srv, req: { event: 'READ', entity: 'Orders', query } };
  }

  // Truncating the response alone still had the database read every row and ship it, so that most
  // of it could be discarded in memory.
  test('sets a limit on the query before it runs', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Orders'] } } });

    await srv.simulateRequest(req, []);

    expect(req.query.SELECT.limit).toEqual({ rows: { val: 100 } });
  });

  test('tightens a client limit that exceeds maxRows', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Orders'] }, limit: { rows: { val: 5000 } } } });

    await srv.simulateRequest(req, []);

    expect(req.query.SELECT.limit.rows.val).toBe(100);
  });

  test('leaves a smaller client limit alone', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Orders'] }, limit: { rows: { val: 10 } } } });

    await srv.simulateRequest(req, []);

    expect(req.query.SELECT.limit.rows.val).toBe(10);
  });

  test('preserves an offset while clamping the row count', async () => {
    const { srv, req } = read({
      SELECT: { from: { ref: ['Orders'] }, limit: { rows: { val: 999 }, offset: { val: 20 } } }
    });

    await srv.simulateRequest(req, []);

    expect(req.query.SELECT.limit).toEqual({ rows: { val: 100 }, offset: { val: 20 } });
  });

  test('observe mode does not touch the query', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Orders'] } } }, 'observe');

    await srv.simulateRequest(req, []);

    expect(req.query.SELECT.limit).toBeUndefined();
  });

  test('still truncates the response, so the two are consistent', async () => {
    const { srv, req } = read({ SELECT: { from: { ref: ['Orders'] } } });
    const results = Array.from({ length: 150 }, (_, i) => ({ ID: i }));

    await srv.simulateRequest(req, results);

    expect(results).toHaveLength(100);
  });
});

describe('nested policy depth', () => {
  // Employees -> department -> staff -> Employees, the cycle a real model has. Level 1 was masked
  // and level 2 was not, so an agent that navigated A -> B -> A read the raw values of the very
  // row it had just been shown masked.
  function linkedModel() {
    const departments = { name: 'Departments', elements: {} };
    const employees = { name: 'Employees', elements: {} };
    employees.elements = { department: { type: 'cds.Association', _target: departments } };
    departments.elements = { staff: { type: 'cds.Association', _target: employees } };
    return { employees, departments };
  }

  const policyDefinition = {
    mode: 'enforce',
    entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget'] } }
  };

  test('masks two levels down, through the association back to the first entity', async () => {
    const { employees } = linkedModel();
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition });

    const results = [
      {
        ID: 1,
        salary: 85000,
        department: { ID: 9, budget: 2500000, staff: [{ ID: 1, salary: 85000 }] }
      }
    ];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: employees }, results);

    expect(results[0].salary).toBe('***MASKED***');
    expect(results[0].department.budget).toBe('***MASKED***');
    expect(results[0].department.staff[0].salary).toBe('***MASKED***');
  });

  test('masks three levels down', async () => {
    const { employees } = linkedModel();
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition });

    const results = [
      {
        ID: 1,
        salary: 1,
        department: {
          ID: 9,
          budget: 2,
          staff: [{ ID: 2, salary: 3, department: { ID: 9, budget: 4 } }]
        }
      }
    ];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: employees }, results);

    expect(results[0].department.staff[0].department.budget).toBe('***MASKED***');
  });

  test('still honours identity scoping at every level', async () => {
    const { employees } = linkedModel();
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: { ...policyDefinition, users: ['mcp-agent'] } });

    const results = [
      { ID: 1, salary: 85000, department: { ID: 9, budget: 2500000, staff: [{ ID: 1, salary: 85000 }] } }
    ];

    await srv.simulateRequest(
      { event: 'READ', entity: 'Employees', user: { id: 'human' }, target: employees },
      results
    );

    expect(results[0].salary).toBe(85000);
    expect(results[0].department.budget).toBe(2500000);
    expect(results[0].department.staff[0].salary).toBe(85000);
  });

  test('observe mode touches nothing at any level', async () => {
    const { employees } = linkedModel();
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition: { ...policyDefinition, mode: 'observe' } });

    const results = [{ ID: 1, salary: 1, department: { ID: 9, budget: 2, staff: [{ ID: 1, salary: 3 }] } }];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: employees }, results);

    expect(results[0].department.staff[0].salary).toBe(3);
  });

  test('stays one level deep on an unlinked model, where the target definition is unavailable', async () => {
    const srv = createFakeService();
    attachInterceptor(srv, { policyDefinition });

    const target = { elements: { department: { type: 'cds.Association', target: 'Departments' } } };
    const results = [{ ID: 1, salary: 1, department: { ID: 9, budget: 2, staff: [{ ID: 1, salary: 3 }] } }];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target }, results);

    expect(results[0].department.budget).toBe('***MASKED***');
    expect(results[0].department.staff[0].salary).toBe(3);
  });
});
