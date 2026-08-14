'use strict';

const { lintPolicy, lintIdentityScoping, formatLintReport } = require('../../lib/policy/lint');

const STRING = { type: 'cds.String' };
const UUID = { type: 'cds.UUID' };
const DECIMAL = { type: 'cds.Decimal' };

describe('lintPolicy — generator output vs field type', () => {
  test('accepts a string generator on a string field', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'syd', type: 'opaque' }] } } },
      { Employees: { syd: STRING } }
    );
    expect(findings.errors).toEqual([]);
  });

  test('accepts the uuid generator on a UUID field', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'personId', type: 'uuid' }] } } },
      { Employees: { personId: UUID } }
    );
    expect(findings.errors).toEqual([]);
  });

  // The defect this whole check exists for: the guard writes 'person-id-0787abd9060d' into a
  // property the service publishes as Edm.Guid. Nothing complains at runtime — the audit log
  // reports it pseudonymized — and it breaks wherever someone actually parses the GUID.
  test('rejects a string generator on a UUID field, and says which type to use', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'personId', type: 'opaque' }] } } },
      { Employees: { personId: UUID } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toContain('Employees.personId');
    expect(findings.errors[0]).toContain('produces a string');
    expect(findings.errors[0]).toContain('cds.UUID');
    expect(findings.errors[0]).toContain('type "uuid"');
  });

  test('rejects the uuid generator on a string field', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'syd', type: 'uuid' }] } } },
      { Employees: { syd: STRING } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toContain('"opaque", "iban" or "custom"');
  });

  test('rejects pseudonymizing a numeric field, where no generator fits', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'salary', type: 'opaque' }] } } },
      { Employees: { salary: DECIMAL } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toContain('cannot be pseudonymized');
  });

  test('says nothing about a field it has no type for', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'syd', type: 'uuid' }] } } },
      { Employees: {} }
    );
    expect(findings.errors).toEqual([]);
    expect(findings.warnings).toEqual([]);
  });

  test('says nothing about an entity absent from the model', () => {
    const findings = lintPolicy(
      { entities: { Ghosts: { pseudonymize: [{ field: 'x', type: 'uuid' }] } } },
      {}
    );
    expect(findings.errors).toEqual([]);
  });
});

describe('lintPolicy — mask warnings', () => {
  test('warns that masking a non-string field yields null, not the placeholder', () => {
    const findings = lintPolicy(
      { entities: { Employees: { mask: ['salary'] } } },
      { Employees: { salary: DECIMAL } }
    );
    expect(findings.errors).toEqual([]);
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]).toContain('yields null');
  });

  test('stays quiet for a masked string field', () => {
    const findings = lintPolicy(
      { entities: { Employees: { mask: ['nationalId'] } } },
      { Employees: { nationalId: STRING } }
    );
    expect(findings.warnings).toEqual([]);
  });
});

describe('lintPolicy — group map', () => {
  test('lists every field bound to each group, across entities', () => {
    const findings = lintPolicy(
      {
        entities: {
          Employees: { pseudonymize: [{ field: 'syd', type: 'opaque', group: 'person-surname' }] },
          Customers: { pseudonymize: [{ field: 'surname', type: 'opaque', group: 'person-surname' }] },
          Vendors: { pseudonymize: [{ field: 'soyad', type: 'opaque', group: 'person-surname' }] }
        }
      },
      {}
    );
    expect(findings.groups['person-surname'].sort()).toEqual([
      'Customers.surname',
      'Employees.syd',
      'Vendors.soyad'
    ]);
  });

  // A typo produces a group of one, which is what makes the report worth reading: two entities
  // meant to share a namespace show up as two separate single-member groups.
  test('a mistyped group shows up as its own single-member entry', () => {
    const findings = lintPolicy(
      {
        entities: {
          Employees: { pseudonymize: [{ field: 'syd', type: 'opaque', group: 'person-surname' }] },
          Customers: { pseudonymize: [{ field: 'surname', type: 'opaque', group: 'person-surename' }] }
        }
      },
      {}
    );
    expect(Object.keys(findings.groups).sort()).toEqual(['person-surename', 'person-surname']);
    expect(findings.groups['person-surename']).toEqual(['Customers.surname']);
  });

  test('ungrouped entries are not in the map', () => {
    const findings = lintPolicy(
      { entities: { Employees: { pseudonymize: [{ field: 'syd', type: 'opaque' }] } } },
      {}
    );
    expect(findings.groups).toEqual({});
  });
});

describe('formatLintReport', () => {
  test('renders the group map, then warnings, then errors', () => {
    const lines = formatLintReport({
      groups: { 'person-id': ['Employees.personId', 'Managers.employeeId'] },
      warnings: ['Employees.salary: masking a cds.Decimal field yields null'],
      errors: ['Employees.personId: pseudonymize type "opaque" produces a string']
    });

    expect(lines[0]).toBe('pseudonym groups:');
    expect(lines).toContain('  person-id');
    expect(lines).toContain('    - Employees.personId');
    expect(lines.some((l) => l.startsWith('warning: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('error: '))).toBe(true);
    expect(lines.findIndex((l) => l.startsWith('warning: '))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('error: '))
    );
  });

  test('is empty for a clean policy with no groups', () => {
    expect(formatLintReport({ groups: {}, warnings: [], errors: [] })).toEqual([]);
  });
});

describe('lintPolicy — mask placeholder settings', () => {
  const DECIMAL = { type: 'cds.Decimal' };

  test('with maskTypeSafe off, warns that the field will contradict its own metadata', () => {
    const findings = lintPolicy(
      { maskTypeSafe: false, entities: { Employees: { mask: ['salary'] } } },
      { Employees: { salary: DECIMAL } }
    );
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]).toContain('contradicts its own $metadata');
    expect(findings.warnings[0]).not.toContain('yields null');
  });

  test('names the configured placeholder rather than the default', () => {
    const findings = lintPolicy(
      { maskValue: '***GIZLI***', entities: { Employees: { mask: ['salary'] } } },
      { Employees: { salary: DECIMAL } }
    );
    expect(findings.warnings[0]).toContain('***GIZLI***');
  });

  test('stays quiet on a string field whichever setting is in force', () => {
    const elements = { Employees: { name: { type: 'cds.String' } } };
    const policy = { entities: { Employees: { mask: ['name'] } } };
    expect(lintPolicy(policy, elements).warnings).toEqual([]);
    expect(lintPolicy({ ...policy, maskTypeSafe: false }, elements).warnings).toEqual([]);
  });
});

describe('lintPolicy — mask strategies vs field type', () => {
  test('stays quiet for a strategy on a string field', () => {
    const findings = lintPolicy(
      {
        entities: {
          Employees: { mask: ['iban', 'email'], maskRules: { iban: { type: 'partial', keepLeft: 4 }, email: { type: 'email' } } }
        }
      },
      { Employees: { iban: STRING, email: STRING } }
    );
    expect(findings.errors).toEqual([]);
    expect(findings.warnings).toEqual([]);
  });

  // The defect: `salary @mcp.policy.mask: {type:'partial', keepLeft:2}` on a Decimal. The rule
  // derives a string, the field can't hold one, so the guard quietly falls back to the full
  // replacement — a payload that looks masked while the configured strategy never ran at all.
  test('reports an error for a strategy on a non-string field, since the rule cannot apply', () => {
    const findings = lintPolicy(
      { entities: { Employees: { mask: ['salary'], maskRules: { salary: { type: 'partial', keepLeft: 2 } } } } },
      { Employees: { salary: DECIMAL } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toContain('Employees.salary');
    expect(findings.errors[0]).toContain('mask type "partial"');
    expect(findings.errors[0]).toContain('cds.Decimal');
    // and not the "yields null" warning as well — one finding per field, the more specific one
    expect(findings.warnings).toEqual([]);
  });

  test('reports the same for a UUID field, which is a string in JS but not in $metadata', () => {
    const findings = lintPolicy(
      { entities: { Employees: { mask: ['personId'], maskRules: { personId: { type: 'partial', keepLeft: 4 } } } } },
      { Employees: { personId: UUID } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toContain('cds.UUID');
  });

  test('a plain full mask on the same entity still only warns', () => {
    const findings = lintPolicy(
      {
        entities: {
          Employees: { mask: ['salary', 'bonus'], maskRules: { salary: { type: 'partial', keepLeft: 2 } } }
        }
      },
      { Employees: { salary: DECIMAL, bonus: DECIMAL } }
    );
    expect(findings.errors).toHaveLength(1);
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]).toContain('Employees.bonus');
  });

  test('says nothing about a strategy field it has no type for', () => {
    const findings = lintPolicy(
      { entities: { Employees: { mask: ['iban'], maskRules: { iban: { type: 'partial' } } } } },
      {}
    );
    expect(findings.errors).toEqual([]);
    expect(findings.warnings).toEqual([]);
  });
});

describe('lintIdentityScoping', () => {
  const withUsers = { users: ['mcp-agent'] };

  // The failure this exists for: under CAP's mocked auth, `users` decides policy from a name that
  // nothing established. A request presenting any other name reads every masked field in the clear,
  // the audit log calls it plainly allowed with nothing to mask, and no part of a running system
  // says the policy stopped applying.
  test('warns when identity scoping rests on a development auth strategy', () => {
    for (const kind of ['mocked', 'basic', 'dummy', 'mock']) {
      const warning = lintIdentityScoping(withUsers, kind);
      expect(warning).toBeDefined();
      expect(warning).toContain(`"${kind}"`);
      expect(warning).toContain('does not verify who the caller is');
    }
  });

  test('names the scoped identities and both ways out', () => {
    const warning = lintIdentityScoping({ users: ['mcp-agent', 'batch-job'] }, 'mocked');
    expect(warning).toContain('"mcp-agent", "batch-job"');
    expect(warning).toContain('XSUAA');
    expect(warning).toContain('its own entity');
  });

  test('is case-insensitive about the strategy name', () => {
    expect(lintIdentityScoping(withUsers, 'Mocked')).toBeDefined();
  });

  test('says nothing for a token-validating strategy', () => {
    for (const kind of ['xsuaa', 'ias', 'jwt']) {
      expect(lintIdentityScoping(withUsers, kind)).toBeUndefined();
    }
  });

  // A project pointing `impl` at its own auth module made a deliberate choice; a warning that fires
  // on every bespoke strategy is one people learn to scroll past.
  test('says nothing for an unrecognized (custom) strategy', () => {
    expect(lintIdentityScoping(withUsers, 'my-company-gateway')).toBeUndefined();
  });

  test('says nothing when identity plays no part in the policy', () => {
    expect(lintIdentityScoping({}, 'mocked')).toBeUndefined();
    expect(lintIdentityScoping({ users: [] }, 'mocked')).toBeUndefined();
    expect(lintIdentityScoping({ services: ['AgentService'] }, 'mocked')).toBeUndefined();
  });

  test('says nothing when the auth strategy is unknown to it', () => {
    expect(lintIdentityScoping(withUsers, undefined)).toBeUndefined();
  });
});
