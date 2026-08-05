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
