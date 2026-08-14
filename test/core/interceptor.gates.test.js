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

describe('mask placeholder vs field type', () => {
  const ELEMENTS = {
    name: { type: 'cds.String' },
    salary: { type: 'cds.Decimal' },
    hiredOn: { type: 'cds.Date' }
  };

  function read(policyExtras) {
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: {
        mode: 'enforce',
        entities: { Employees: { mask: ['name', 'salary', 'hiredOn'] } },
        ...policyExtras
      }
    });
    return {
      srv,
      req: { event: 'READ', entity: 'Employees', target: { name: 'Employees', elements: ELEMENTS } }
    };
  }

  // The default assumes a typed consumer: Fiori renders a string in a Decimal column as an empty
  // cell, which reads as "no value" rather than "withheld".
  test('by default a non-string field is masked to null, a string one to the placeholder', async () => {
    const { srv, req } = read();
    const results = [{ name: 'Ada', salary: 85000, hiredOn: '2020-01-01' }];

    await srv.simulateRequest(req, results);

    expect(results[0].name).toBe('***MASKED***');
    expect(results[0].salary).toBeNull();
    expect(results[0].hiredOn).toBeNull();
  });

  // When the masked copy only ever reaches an agent reading JSON, a null is strictly less
  // informative than the placeholder — it can't be told apart from an empty column.
  test('maskTypeSafe: false puts the placeholder on every masked field', async () => {
    const { srv, req } = read({ maskTypeSafe: false });
    const results = [{ name: 'Ada', salary: 85000, hiredOn: '2020-01-01' }];

    await srv.simulateRequest(req, results);

    expect(results[0].name).toBe('***MASKED***');
    expect(results[0].salary).toBe('***MASKED***');
    expect(results[0].hiredOn).toBe('***MASKED***');
  });

  test('maskValue replaces the placeholder text', async () => {
    const { srv, req } = read({ maskValue: '***GIZLI***' });
    const results = [{ name: 'Ada', salary: 85000 }];

    await srv.simulateRequest(req, results);

    expect(results[0].name).toBe('***GIZLI***');
    expect(results[0].salary).toBeNull();
  });

  test('maskValue and maskTypeSafe compose', async () => {
    const { srv, req } = read({ maskValue: '[redacted]', maskTypeSafe: false });
    const results = [{ name: 'Ada', salary: 85000, hiredOn: '2020-01-01' }];

    await srv.simulateRequest(req, results);

    expect(results[0]).toEqual({ name: '[redacted]', salary: '[redacted]', hiredOn: '[redacted]' });
  });

  test('applies to expanded rows as well, not just the top level', async () => {
    const departments = { name: 'Departments', elements: { budget: { type: 'cds.Decimal' } } };
    const employees = {
      name: 'Employees',
      elements: { ...ELEMENTS, department: { type: 'cds.Association', _target: departments } }
    };
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: {
        mode: 'enforce',
        maskTypeSafe: false,
        entities: { Employees: { mask: ['salary'] }, Departments: { mask: ['budget'] } }
      }
    });
    const results = [{ salary: 1, department: { budget: 2 } }];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: employees }, results);

    expect(results[0].salary).toBe('***MASKED***');
    expect(results[0].department.budget).toBe('***MASKED***');
  });
});

/**
 * The strategies that derive their output from the real value, so the replacement can only be
 * computed per row rather than once per field — the plugin's answer to a rule table row reading
 * "IBAN, partial, keepLeft 4, keepRight 4".
 */
describe('per-field mask strategies', () => {
  const ELEMENTS = {
    iban: { type: 'cds.String' },
    email: { type: 'cds.String' },
    salary: { type: 'cds.Decimal' }
  };

  function read(entityConfig, policyExtras) {
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: { mode: 'enforce', entities: { Employees: entityConfig }, ...policyExtras }
    });
    return {
      srv,
      req: { event: 'READ', entity: 'Employees', target: { name: 'Employees', elements: ELEMENTS } }
    };
  }

  test('applies a partial rule per row, so each value keeps its own length', async () => {
    const { srv, req } = read({
      mask: ['iban'],
      maskRules: { iban: { type: 'partial', keepLeft: 4, keepRight: 4 } }
    });
    const results = [{ iban: 'TR330006100519786457841326' }, { iban: 'DE89370400440532013000' }];

    await srv.simulateRequest(req, results);

    expect(results[0].iban).toBe('TR33******************1326');
    expect(results[1].iban).toBe('DE89**************3000');
  });

  test('applies an email rule', async () => {
    const { srv, req } = read({ mask: ['email'], maskRules: { email: { type: 'email' } } });
    const results = [{ email: 'ahmet@firma.com' }];

    await srv.simulateRequest(req, results);

    expect(results[0].email).toBe('a****@firma.com');
  });

  test('a field with no rule is still masked to the placeholder, in the same response', async () => {
    const { srv, req } = read({
      mask: ['iban', 'email'],
      maskRules: { iban: { type: 'partial', keepLeft: 4, keepRight: 4 } }
    });
    const results = [{ iban: 'TR330006100519786457841326', email: 'ahmet@firma.com' }];

    await srv.simulateRequest(req, results);

    expect(results[0].iban).toBe('TR33******************1326');
    expect(results[0].email).toBe('***MASKED***');
  });

  // A value the rule can't process must not come back readable — it falls through to whatever the
  // full mask would have been for that field.
  test('a value the rule cannot process falls back to the full replacement', async () => {
    const { srv, req } = read({ mask: ['email'], maskRules: { email: { type: 'email' } } });
    const results = [{ email: 'not-an-email' }, { email: null }];

    await srv.simulateRequest(req, results);

    expect(results[0].email).toBe('***MASKED***');
    expect(results[1].email).toBe('***MASKED***');
  });

  test('the fallback honours maskValue', async () => {
    const { srv, req } = read({ mask: ['email'], maskRules: { email: { type: 'email' } } }, { maskValue: '***GIZLI***' });
    const results = [{ email: 'bozuk-adres' }];

    await srv.simulateRequest(req, results);

    expect(results[0].email).toBe('***GIZLI***');
  });

  // The rule produces a string and a Decimal property can't hold one, so the full replacement
  // stands in. lint.js reports the mismatch at startup — this is what happens if it's ignored.
  test('a rule on a non-string field falls back to the type-safe full mask', async () => {
    const { srv, req } = read({
      mask: ['salary'],
      maskRules: { salary: { type: 'partial', keepLeft: 2, keepRight: 2 } }
    });
    const results = [{ salary: 85000 }];

    await srv.simulateRequest(req, results);

    expect(results[0].salary).toBeNull();
  });

  // With type-safety off the response already contradicts its own $metadata by design, so a
  // partially-masked number is no worse than a placeholder string there.
  test('with maskTypeSafe off, the rule does run on a non-string field', async () => {
    const { srv, req } = read(
      { mask: ['salary'], maskRules: { salary: { type: 'partial', keepLeft: 2, keepRight: 2 } } },
      { maskTypeSafe: false }
    );
    const results = [{ salary: 85000 }];

    await srv.simulateRequest(req, results);

    expect(results[0].salary).toBe('85*00');
  });

  test('observe mode leaves the real value alone', async () => {
    const { srv, req } = read(
      { mask: ['iban'], maskRules: { iban: { type: 'partial', keepLeft: 4, keepRight: 4 } } },
      { mode: 'observe' }
    );
    const results = [{ iban: 'TR330006100519786457841326' }];

    await srv.simulateRequest(req, results);

    expect(results[0].iban).toBe('TR330006100519786457841326');
  });

  test('applies to expanded rows using the nested entity\'s own rules', async () => {
    const departments = { name: 'Departments', elements: { contact: { type: 'cds.String' } } };
    const employees = {
      name: 'Employees',
      elements: { ...ELEMENTS, department: { type: 'cds.Association', _target: departments } }
    };
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: {
        mode: 'enforce',
        entities: {
          Employees: { mask: ['iban'], maskRules: { iban: { type: 'partial', keepLeft: 4, keepRight: 4 } } },
          Departments: { mask: ['contact'], maskRules: { contact: { type: 'email' } } }
        }
      }
    });
    const results = [{ iban: 'TR330006100519786457841326', department: { contact: 'ahmet@firma.com' } }];

    await srv.simulateRequest({ event: 'READ', entity: 'Employees', target: employees }, results);

    expect(results[0].iban).toBe('TR33******************1326');
    expect(results[0].department.contact).toBe('a****@firma.com');
  });

  // The rule lives on the policy, not the Decision, precisely so these two keep publishing the
  // plain list of names every consumer already parses.
  test('the Decision still reports fieldsToMask as plain field names', async () => {
    const decisions = [];
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: {
        mode: 'enforce',
        entities: { Employees: { mask: ['iban'], maskRules: { iban: { type: 'partial', keepLeft: 4 } } } }
      },
      onDecision: (decision) => decisions.push(decision)
    });

    await srv.simulateRequest(
      { event: 'READ', entity: 'Employees', target: { name: 'Employees', elements: ELEMENTS } },
      [{ iban: 'TR330006100519786457841326' }]
    );

    expect(decisions[0].fieldsToMask).toEqual(['iban']);
  });
});

/**
 * Path scoping's read side: the guard has to see which door a request arrived at, and that has to
 * keep working when a runtime mounted elsewhere queries the service internally rather than over
 * HTTP — which is the whole case it exists for.
 */
describe('inbound path scoping', () => {
  const ELEMENTS = { salary: { type: 'cds.String' } };

  function read(path, policyExtras) {
    const srv = createFakeService();
    attachInterceptor(srv, {
      policyDefinition: { mode: 'enforce', paths: ['/mcp'], entities: { Employees: { mask: ['salary'] } }, ...policyExtras }
    });
    return {
      srv,
      req: {
        event: 'READ',
        entity: 'Employees',
        target: { name: 'Employees', elements: ELEMENTS },
        ...(path !== undefined && { http: { req: { originalUrl: path } } })
      }
    };
  }

  const salaryAfter = async (path, extras) => {
    const { srv, req } = read(path, extras);
    const results = [{ salary: '85000' }];
    await srv.simulateRequest(req, results);
    return results[0].salary;
  };

  test('masks a request that arrived on the scoped path', async () => {
    expect(await salaryAfter('/mcp')).toBe('***MASKED***');
  });

  test('leaves a request that arrived on another path alone', async () => {
    expect(await salaryAfter('/odata/v4/catalog/Employees')).toBe('85000');
  });

  // The query string is not part of the door — leaving it on would break every prefix comparison.
  test('ignores the query string when matching', async () => {
    expect(await salaryAfter('/mcp?sessionId=abc')).toBe('***MASKED***');
    expect(await salaryAfter('/odata/v4/catalog/Employees?$top=1')).toBe('85000');
  });

  // A runtime that queries the service without preserving the outer request would otherwise get
  // real values, silently. Leaning the ambiguous case towards masking makes that a visible failure.
  test('a request with no HTTP context at all is masked by default', async () => {
    expect(await salaryAfter(undefined)).toBe('***MASKED***');
  });

  test('whenPathUnknown: "pass" lets a context-less internal call through unmasked', async () => {
    expect(await salaryAfter(undefined, { whenPathUnknown: 'pass' })).toBe('85000');
  });

  test('without "paths" the policy applies whatever the path', async () => {
    expect(await salaryAfter('/odata/v4/catalog/Employees', { paths: undefined })).toBe('***MASKED***');
  });

  test('the gates still run for an in-scope request, and not for an out-of-scope one', async () => {
    const inScope = read('/mcp');
    inScope.req.query = { SELECT: { from: { ref: ['Employees'] }, where: [{ ref: ['salary'] }, '>', { val: 1 }] } };
    inScope.req.reject = (code, reason) => {
      throw new Error(`${code}: ${reason}`);
    };
    await expect(inScope.srv.simulateRequest(inScope.req, [])).rejects.toThrow(/403: query computes over/);

    const outOfScope = read('/odata/v4/catalog/Employees');
    outOfScope.req.query = { SELECT: { from: { ref: ['Employees'] }, where: [{ ref: ['salary'] }, '>', { val: 1 }] } };
    await expect(outOfScope.srv.simulateRequest(outOfScope.req, [])).resolves.toBeUndefined();
  });

  test('falls back through originalUrl -> path -> url', async () => {
    const bySource = async (httpReq) => {
      const srv = createFakeService();
      attachInterceptor(srv, {
        policyDefinition: { mode: 'enforce', paths: ['/mcp'], entities: { Employees: { mask: ['salary'] } } }
      });
      const results = [{ salary: '85000' }];
      await srv.simulateRequest(
        { event: 'READ', entity: 'Employees', target: { name: 'Employees', elements: ELEMENTS }, http: { req: httpReq } },
        results
      );
      return results[0].salary;
    };

    expect(await bySource({ path: '/mcp' })).toBe('***MASKED***');
    expect(await bySource({ url: '/mcp' })).toBe('***MASKED***');
    expect(await bySource({ originalUrl: '/mcp', path: '/odata' })).toBe('***MASKED***');
  });
});
