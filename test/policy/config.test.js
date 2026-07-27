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
