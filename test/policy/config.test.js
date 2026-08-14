'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseConfig, loadConfig } = require('../../lib/policy/config');

describe('parseConfig', () => {
  test('parses a valid config into the expected PolicyDefinition', () => {
    const raw = {
      mode: 'enforce',
      entities: {
        Orders: { mask: ['CreditCard', 'Salary'], maxRows: 100, allowTools: ['ReadOrders'] },
        Customers: { mask: ['Email', 'Phone'] }
      }
    };

    expect(parseConfig(raw)).toEqual({
      mode: 'enforce',
      entities: {
        Orders: {
          mask: ['CreditCard', 'Salary'],
          maxRows: 100,
          allowTools: ['ReadOrders']
        },
        Customers: {
          mask: ['Email', 'Phone'],
          maxRows: undefined,
          allowTools: undefined
        }
      }
    });
  });

  test('accepts mode: observe', () => {
    expect(parseConfig({ mode: 'observe', entities: {} }).mode).toBe('observe');
  });

  test('throws when mode is missing', () => {
    expect(() => parseConfig({ entities: {} })).toThrow(/"mode" must be one of enforce, observe/);
  });

  test('throws when mode has an invalid value', () => {
    expect(() => parseConfig({ mode: 'yolo' })).toThrow(/"mode" must be one of enforce, observe/);
  });

  test('throws when the config itself is not a mapping', () => {
    expect(() => parseConfig('mode: enforce')).toThrow(/"cap-mcp-guard" must be a mapping with a "mode" key/);
  });

  test('uses the provided source label in the wrapped error', () => {
    expect(() => parseConfig(null, { source: '/tmp/my-package.json' })).toThrow(
      /^\/tmp\/my-package\.json: "cap-mcp-guard" must be a mapping/
    );
  });

  test('throws when entities.<name>.mask is a string instead of an array', () => {
    const raw = { mode: 'enforce', entities: { Orders: { mask: 'CreditCard' } } };
    expect(() => parseConfig(raw)).toThrow('entities.Orders.mask must be an array, got string');
  });

  test('throws when entities.<name>.allowTools is a string instead of an array', () => {
    const raw = { mode: 'enforce', entities: { Orders: { allowTools: 'ReadOrders' } } };
    expect(() => parseConfig(raw)).toThrow('entities.Orders.allowTools must be an array, got string');
  });

  test('throws when maxRows is not a number', () => {
    const raw = { mode: 'enforce', entities: { Orders: { maxRows: 'many' } } };
    expect(() => parseConfig(raw)).toThrow('entities.Orders.maxRows must be a number, got string');
  });

  test('throws when maxRows is negative', () => {
    const raw = { mode: 'enforce', entities: { Orders: { maxRows: -5 } } };
    expect(() => parseConfig(raw)).toThrow('entities.Orders.maxRows must not be negative (got -5)');
  });

  test('accepts an empty entities object as valid', () => {
    expect(parseConfig({ mode: 'enforce', entities: {} })).toEqual({ mode: 'enforce', entities: {} });
  });

  test('accepts a config with no entities key at all', () => {
    expect(parseConfig({ mode: 'enforce' })).toEqual({ mode: 'enforce', entities: {} });
  });

  test('accepts an entity with only its name and no mask/maxRows/allowTools', () => {
    const raw = { mode: 'enforce', entities: { Books: null } };
    expect(parseConfig(raw)).toEqual({
      mode: 'enforce',
      entities: {
        Books: { mask: undefined, maxRows: undefined, allowTools: undefined }
      }
    });
  });

  test('accepts a "services" array and returns it', () => {
    const raw = { mode: 'enforce', services: ['AgentCatalogService'] };
    expect(parseConfig(raw).services).toEqual(['AgentCatalogService']);
  });

  test('"services" is undefined (not []) when omitted, so callers can tell "no filter" apart from "filter to nothing"', () => {
    expect(parseConfig({ mode: 'enforce' }).services).toBeUndefined();
  });

  test('throws when "services" is not an array', () => {
    const raw = { mode: 'enforce', services: 'AgentCatalogService' };
    expect(() => parseConfig(raw)).toThrow('"services" must be an array, got string');
  });

  test('accepts a "users" array and returns it', () => {
    const raw = { mode: 'enforce', users: ['mcp-agent-technical-user'] };
    expect(parseConfig(raw).users).toEqual(['mcp-agent-technical-user']);
  });

  test('"users" is undefined (not []) when omitted, so callers can tell "no filter" apart from "filter to nothing"', () => {
    expect(parseConfig({ mode: 'enforce' }).users).toBeUndefined();
  });

  test('throws when "users" is not an array', () => {
    const raw = { mode: 'enforce', users: 'mcp-agent-technical-user' };
    expect(() => parseConfig(raw)).toThrow('"users" must be an array, got string');
  });

  describe('"audit"', () => {
    test('accepts an "audit.filePath" and returns it', () => {
      const raw = { mode: 'enforce', audit: { filePath: 'audit.log' } };
      expect(parseConfig(raw).audit).toEqual({ filePath: 'audit.log' });
    });

    test('accepts an "audit.stdout" flag alongside filePath', () => {
      const raw = { mode: 'enforce', audit: { filePath: 'audit.log', stdout: false } };
      expect(parseConfig(raw).audit).toEqual({ filePath: 'audit.log', stdout: false });
    });

    test('"audit" is undefined when omitted', () => {
      expect(parseConfig({ mode: 'enforce' }).audit).toBeUndefined();
    });

    test('throws when "audit" is not a mapping', () => {
      const raw = { mode: 'enforce', audit: 'audit.log' };
      expect(() => parseConfig(raw)).toThrow('"audit" must be a mapping, got string');
    });

    test('throws when "audit.filePath" is not a string', () => {
      const raw = { mode: 'enforce', audit: { filePath: 123 } };
      expect(() => parseConfig(raw)).toThrow('"audit.filePath" must be a string, got number');
    });

    test('throws when "audit.stdout" is not a boolean', () => {
      const raw = { mode: 'enforce', audit: { stdout: 'yes' } };
      expect(() => parseConfig(raw)).toThrow('"audit.stdout" must be a boolean, got string');
    });
  });

  describe('"maskValue" / "maskTypeSafe"', () => {
    test('accepts a custom placeholder', () => {
      expect(parseConfig({ mode: 'enforce', maskValue: '***GIZLI***' }).maskValue).toBe('***GIZLI***');
    });

    test('accepts maskTypeSafe: false', () => {
      expect(parseConfig({ mode: 'enforce', maskTypeSafe: false }).maskTypeSafe).toBe(false);
    });

    test('both are absent when omitted, so the defaults stay in the interceptor', () => {
      const parsed = parseConfig({ mode: 'enforce' });
      expect(parsed.maskValue).toBeUndefined();
      expect(parsed.maskTypeSafe).toBeUndefined();
    });

    test('throws when maskValue is not a non-empty string', () => {
      expect(() => parseConfig({ mode: 'enforce', maskValue: '' })).toThrow(
        '"maskValue" must be a non-empty string, got string'
      );
      expect(() => parseConfig({ mode: 'enforce', maskValue: 42 })).toThrow(
        '"maskValue" must be a non-empty string, got number'
      );
    });

    test('throws when maskTypeSafe is not a boolean', () => {
      expect(() => parseConfig({ mode: 'enforce', maskTypeSafe: 'no' })).toThrow(
        '"maskTypeSafe" must be a boolean, got string'
      );
    });
  });

  describe('"paths"', () => {
    test('accepts an array of root-anchored prefixes and returns it', () => {
      expect(parseConfig({ mode: 'enforce', paths: ['/mcp', '/agent-api'] }).paths).toEqual(['/mcp', '/agent-api']);
    });

    test('is absent from the PolicyDefinition when omitted, so the policy applies on every path', () => {
      expect(parseConfig({ mode: 'enforce' })).not.toHaveProperty('paths');
    });

    test('throws when it is not an array', () => {
      expect(() => parseConfig({ mode: 'enforce', paths: '/mcp' })).toThrow('"paths" must be an array, got string');
    });

    // A bare "mcp" prefix-matches nothing, which would silently scope the policy to no request at
    // all — the one mistake here that looks exactly like a working config.
    test('throws on an entry that is not root-anchored', () => {
      expect(() => parseConfig({ mode: 'enforce', paths: ['mcp'] })).toThrow(
        '"paths" entries must be strings starting with "/" (got "mcp")'
      );
      expect(() => parseConfig({ mode: 'enforce', paths: [42] })).toThrow('got 42');
      expect(() => parseConfig({ mode: 'enforce', paths: [null] })).toThrow('got null');
    });

    test('an empty array is accepted and scopes the policy to nothing', () => {
      expect(parseConfig({ mode: 'enforce', paths: [] }).paths).toEqual([]);
    });
  });

  describe('per-field mask strategies', () => {
    const parseMask = (mask) => parseConfig({ mode: 'enforce', entities: { Employees: { mask } } }).entities.Employees;

    // The split is the point: `mask` stays the plain name list the audit log and the OTel span
    // already publish, and the strategy travels beside it.
    test('splits an entry object into a masked field name plus a rule', () => {
      const config = parseMask([{ field: 'iban', type: 'partial', keepLeft: 4, keepRight: 4, char: '*' }]);

      expect(config.mask).toEqual(['iban']);
      expect(config.maskRules).toEqual({ iban: { type: 'partial', keepLeft: 4, keepRight: 4, char: '*' } });
    });

    test('bare field names still produce no rules at all, so nothing changes for an existing config', () => {
      const config = parseMask(['salary', 'iban']);

      expect(config.mask).toEqual(['salary', 'iban']);
      expect(config).not.toHaveProperty('maskRules');
    });

    test('mixes bare names and strategies in one array', () => {
      const config = parseMask(['salary', { field: 'email', type: 'email' }]);

      expect(config.mask).toEqual(['salary', 'email']);
      expect(config.maskRules).toEqual({ email: { type: 'email' } });
    });

    test('an explicit type "full" is a masked field with no rule, the same as the bare name', () => {
      const config = parseMask([{ field: 'salary', type: 'full' }]);

      expect(config.mask).toEqual(['salary']);
      expect(config).not.toHaveProperty('maskRules');
    });

    test('an entry object without a type defaults to "full"', () => {
      expect(parseMask([{ field: 'salary' }])).toMatchObject({ mask: ['salary'] });
    });

    test('a strategy field still collides with pseudonymize', () => {
      const raw = {
        mode: 'enforce',
        entities: { Employees: { mask: [{ field: 'iban', type: 'partial' }], pseudonymize: ['iban'] } }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Employees: "iban" cannot be listed in both "mask" and "pseudonymize"'
      );
    });

    test('throws on an unknown mask type', () => {
      expect(() => parseMask([{ field: 'tckn', type: 'tckn' }])).toThrow(
        'entities.Employees.mask.tckn.type must be one of full, partial, email (got "tckn")'
      );
    });

    test('throws on an entry that is neither a string nor an object', () => {
      expect(() => parseMask([42])).toThrow(
        'entities.Employees.mask entries must be a string or a {field, type} object, got number'
      );
      expect(() => parseMask([null])).toThrow('got null');
    });

    test('throws on an entry object with no usable field name', () => {
      expect(() => parseMask([{ type: 'partial' }])).toThrow(
        'entities.Employees.mask entries must have a "field" string'
      );
      expect(() => parseMask([''])).toThrow('entities.Employees.mask entries must be non-empty strings');
    });

    // Rejected rather than ignored: a config asking for something it will not get should say so at
    // load time, not leave someone reading a fully-masked payload wondering why keepLeft did nothing.
    test('throws when keepLeft/keepRight are used with a type that has no bounds', () => {
      expect(() => parseMask([{ field: 'email', type: 'email', keepLeft: 2 }])).toThrow(
        'entities.Employees.mask.email: "keepLeft" is only allowed with type "partial"'
      );
      expect(() => parseMask([{ field: 'salary', keepRight: 2 }])).toThrow(
        'entities.Employees.mask.salary: "keepRight" is only allowed with type "partial"'
      );
    });

    test('throws when a bound is not a non-negative integer', () => {
      expect(() => parseMask([{ field: 'iban', type: 'partial', keepLeft: -1 }])).toThrow(
        'entities.Employees.mask.iban.keepLeft must be a non-negative integer, got -1'
      );
      expect(() => parseMask([{ field: 'iban', type: 'partial', keepRight: 1.5 }])).toThrow(
        'entities.Employees.mask.iban.keepRight must be a non-negative integer, got 1.5'
      );
      expect(() => parseMask([{ field: 'iban', type: 'partial', keepLeft: '4' }])).toThrow(
        'must be a non-negative integer, got "4"'
      );
    });

    test('keepLeft/keepRight of 0 are accepted — they mean "keep nothing at this end"', () => {
      expect(parseMask([{ field: 'iban', type: 'partial', keepLeft: 0, keepRight: 4 }]).maskRules).toEqual({
        iban: { type: 'partial', keepLeft: 0, keepRight: 4 }
      });
    });

    test('throws when "char" is used on a full mask, and points at the setting that does apply', () => {
      expect(() => parseMask([{ field: 'salary', char: '#' }])).toThrow(
        'entities.Employees.mask.salary: "char" is only allowed with type "partial" or "email"'
      );
      expect(() => parseMask([{ field: 'salary', char: '#' }])).toThrow('use "maskValue"');
    });

    test('throws when "char" is not a single character', () => {
      expect(() => parseMask([{ field: 'iban', type: 'partial', char: '**' }])).toThrow(
        'entities.Employees.mask.iban.char must be a single character, got "**"'
      );
      expect(() => parseMask([{ field: 'iban', type: 'partial', char: '' }])).toThrow('got ""');
    });

    // Counted by code point, so an emoji is one character rather than two UTF-16 units.
    test('accepts a multi-byte character as "char"', () => {
      expect(parseMask([{ field: 'iban', type: 'partial', char: '█' }]).maskRules.iban.char).toBe('█');
    });
  });

  describe('"pseudonymGroups"', () => {
    test('accepts an allowlist and returns it', () => {
      const raw = { mode: 'enforce', pseudonymGroups: ['person-id', 'person-surname'] };
      expect(parseConfig(raw).pseudonymGroups).toEqual(['person-id', 'person-surname']);
    });

    test('is absent from the PolicyDefinition when omitted, keeping groups free-form', () => {
      expect(parseConfig({ mode: 'enforce' }).pseudonymGroups).toBeUndefined();
    });

    test('accepts a group that is on the list', () => {
      const raw = {
        mode: 'enforce',
        pseudonymGroups: ['person-surname'],
        entities: { Employees: { pseudonymize: [{ field: 'syd', group: 'person-surname' }] } }
      };
      expect(() => parseConfig(raw)).not.toThrow();
    });

    // The typo case the allowlist exists for: two entities meant to share a namespace end up in
    // two, and nothing at runtime says so — the pseudonyms just never match.
    test('throws for a group that is not on the list, naming both the group and the list', () => {
      const raw = {
        mode: 'enforce',
        pseudonymGroups: ['person-surname'],
        entities: { Customers: { pseudonymize: [{ field: 'surname', group: 'person-surename' }] } }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.surname: group "person-surename" is not in "pseudonymGroups" ("person-surname")'
      );
    });

    test('ignores entries that use no group at all', () => {
      const raw = {
        mode: 'enforce',
        pseudonymGroups: ['person-id'],
        entities: { Employees: { pseudonymize: [{ field: 'syd' }] } }
      };
      expect(() => parseConfig(raw)).not.toThrow();
    });

    test('throws when the allowlist is not an array', () => {
      expect(() => parseConfig({ mode: 'enforce', pseudonymGroups: 'person-id' })).toThrow(
        '"pseudonymGroups" must be an array, got string'
      );
    });

    test('throws when an allowlist entry is not a non-empty string', () => {
      expect(() => parseConfig({ mode: 'enforce', pseudonymGroups: ['person-id', ''] })).toThrow(
        '"pseudonymGroups" entries must be non-empty strings, got ""'
      );
    });
  });

  describe('"lint"', () => {
    test('accepts true', () => {
      expect(parseConfig({ mode: 'enforce', lint: true }).lint).toBe(true);
    });

    test('accepts { strict: true }', () => {
      expect(parseConfig({ mode: 'enforce', lint: { strict: true } }).lint).toEqual({ strict: true });
    });

    test('is absent when omitted, so the lint stays off by default', () => {
      expect(parseConfig({ mode: 'enforce' }).lint).toBeUndefined();
    });

    test('throws when lint is neither a boolean nor a mapping', () => {
      expect(() => parseConfig({ mode: 'enforce', lint: 'strict' })).toThrow(
        '"lint" must be a boolean or a mapping, got string'
      );
    });

    test('throws when lint.strict is not a boolean', () => {
      expect(() => parseConfig({ mode: 'enforce', lint: { strict: 'yes' } })).toThrow(
        '"lint.strict" must be a boolean, got string'
      );
    });
  });

  describe('entities.<name>.pseudonymize', () => {
    test('normalizes a bare string entry to { field, type: "opaque" }', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: ['Email'] } } };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([{ field: 'Email', type: 'opaque' }]);
    });

    test('accepts a { field, type } object entry as-is', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ field: 'IBAN', type: 'iban' }] } } };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([{ field: 'IBAN', type: 'iban' }]);
    });

    test('a { field } object without a type defaults to "opaque"', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ field: 'Email' }] } } };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([{ field: 'Email', type: 'opaque' }]);
    });

    test('is undefined (not []) when omitted', () => {
      const raw = { mode: 'enforce', entities: { Customers: { mask: ['CreditCard'] } } };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toBeUndefined();
    });

    test('throws when pseudonymize is not an array', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: 'IBAN' } } };
      expect(() => parseConfig(raw)).toThrow('entities.Customers.pseudonymize must be an array, got string');
    });

    test('throws when an entry has an unknown type', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ field: 'IBAN', type: 'creditCard' }] } } };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.IBAN.type must be one of opaque, iban, uuid, custom (got "creditCard")'
      );
    });

    test('accepts a { field, type: "custom", value } entry as-is', () => {
      const raw = {
        mode: 'enforce',
        entities: { Customers: { pseudonymize: [{ field: 'Email', type: 'custom', value: 'hidden@example.com' }] } }
      };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([
        { field: 'Email', type: 'custom', value: 'hidden@example.com' }
      ]);
    });

    test('throws when type is "custom" and "value" is missing', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ field: 'Email', type: 'custom' }] } } };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.Email: type "custom" requires a non-empty "value" string'
      );
    });

    test('throws when type is "custom" and "value" is an empty string', () => {
      const raw = {
        mode: 'enforce',
        entities: { Customers: { pseudonymize: [{ field: 'Email', type: 'custom', value: '' }] } }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.Email: type "custom" requires a non-empty "value" string'
      );
    });

    test('throws when "value" is given for a non-"custom" type', () => {
      const raw = {
        mode: 'enforce',
        entities: { Customers: { pseudonymize: [{ field: 'IBAN', type: 'iban', value: 'whatever' }] } }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.IBAN: "value" is only allowed with type "custom"'
      );
    });

    test('keeps a "group" on the parsed entry', () => {
      const raw = {
        mode: 'enforce',
        entities: { Customers: { pseudonymize: [{ field: 'soyad', group: 'surname' }] } }
      };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([
        { field: 'soyad', type: 'opaque', group: 'surname' }
      ]);
    });

    test('omits "group" entirely when not given, rather than setting it undefined', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: ['soyad'] } } };
      expect(parseConfig(raw).entities.Customers.pseudonymize).toEqual([{ field: 'soyad', type: 'opaque' }]);
    });

    test('throws when "group" is not a non-empty string', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ field: 'soyad', group: '' }] } } };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.soyad: "group" must be a non-empty string'
      );
    });

    test('throws when "group" is combined with type "custom", which derives nothing from it', () => {
      const raw = {
        mode: 'enforce',
        entities: {
          Customers: { pseudonymize: [{ field: 'soyad', type: 'custom', value: 'X', group: 'surname' }] }
        }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize.soyad: "group" is not allowed with type "custom"'
      );
    });

    test('accepts the "uuid" type', () => {
      const raw = { mode: 'enforce', entities: { Employees: { pseudonymize: [{ field: 'personId', type: 'uuid' }] } } };
      expect(parseConfig(raw).entities.Employees.pseudonymize).toEqual([{ field: 'personId', type: 'uuid' }]);
    });

    test('throws when an object entry has no "field"', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [{ type: 'iban' }] } } };
      expect(() => parseConfig(raw)).toThrow('entities.Customers.pseudonymize entries must have a "field" string');
    });

    test('throws when an entry is neither a string nor an object', () => {
      const raw = { mode: 'enforce', entities: { Customers: { pseudonymize: [42] } } };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers.pseudonymize entries must be a string or a {field, type} object, got number'
      );
    });

    test('throws when the same field is listed in both "mask" and "pseudonymize"', () => {
      const raw = {
        mode: 'enforce',
        entities: { Customers: { mask: ['IBAN'], pseudonymize: ['IBAN'] } }
      };
      expect(() => parseConfig(raw)).toThrow(
        'entities.Customers: "IBAN" cannot be listed in both "mask" and "pseudonymize"'
      );
    });
  });
});

describe('loadConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePackageJson(tmpDirPath, capMcpGuardConfig) {
    const filePath = path.join(tmpDirPath, 'package.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'fixture', 'cap-mcp-guard': capMcpGuardConfig }));
    return filePath;
  }

  test('reads and parses the "cap-mcp-guard" key from a real package.json on disk', () => {
    const filePath = writePackageJson(tmpDir, { mode: 'observe', entities: { Orders: { mask: ['CreditCard'] } } });

    expect(loadConfig(filePath)).toEqual({
      mode: 'observe',
      entities: { Orders: { mask: ['CreditCard'], maxRows: undefined, allowTools: undefined } }
    });
  });

  test('throws a "not configured" error when the package.json file does not exist', () => {
    const filePath = path.join(tmpDir, 'does-not-exist.json');
    expect(() => loadConfig(filePath)).toThrow(/^cap-mcp-guard not configured: no package\.json found at /);
  });

  test('throws a "not configured" error when package.json exists but has no "cap-mcp-guard" key', () => {
    const filePath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'fixture' }));

    expect(() => loadConfig(filePath)).toThrow(/^cap-mcp-guard not configured: "cap-mcp-guard" key not found in /);
  });

  test('wraps JSON syntax errors with the real file path', () => {
    const filePath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(filePath, '{ invalid json');

    expect(() => loadConfig(filePath)).toThrow(new RegExp(`^Failed to parse ${filePath.replace(/\\/g, '\\\\')}: `));
  });
});

describe('parseConfig — "otherSurfacesGated"', () => {
  test('accepts a boolean and carries it through', () => {
    expect(parseConfig({ mode: 'enforce', otherSurfacesGated: true }).otherSurfacesGated).toBe(true);
  });

  test('is absent when omitted', () => {
    expect(parseConfig({ mode: 'enforce' })).not.toHaveProperty('otherSurfacesGated');
  });

  test('throws when it is not a boolean', () => {
    expect(() => parseConfig({ mode: 'enforce', otherSurfacesGated: 'yes' })).toThrow(
      '"otherSurfacesGated" must be a boolean, got string'
    );
  });
});
