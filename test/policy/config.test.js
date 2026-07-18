'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseConfig, loadConfig } = require('../../lib/policy/config');

describe('parseConfig', () => {
  test('parses a valid config into the expected PolicyDefinition', () => {
    const yamlString = `
mode: enforce

entities:
  Orders:
    mask: [CreditCard, Salary]
    maxRows: 100
    allowTools: [ReadOrders]

  Customers:
    mask: [Email, Phone]
`;

    expect(parseConfig(yamlString)).toEqual({
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
    expect(parseConfig('mode: observe\nentities: {}').mode).toBe('observe');
  });

  test('throws when mode is missing', () => {
    expect(() => parseConfig('entities: {}')).toThrow(/"mode" must be one of enforce, observe/);
  });

  test('throws when mode has an invalid value', () => {
    expect(() => parseConfig('mode: yolo')).toThrow(/"mode" must be one of enforce, observe/);
  });

  test('throws a wrapped, readable error on malformed YAML syntax', () => {
    const brokenYaml = 'mode: enforce\nentities:\n  Orders: [unclosed';
    expect(() => parseConfig(brokenYaml)).toThrow(/^Failed to parse cap-mcp-guard\.yaml: /);
  });

  test('uses the provided source label in the wrapped YAML error', () => {
    const brokenYaml = 'mode: [unclosed';
    expect(() => parseConfig(brokenYaml, { source: '/tmp/my-config.yaml' })).toThrow(
      /^Failed to parse \/tmp\/my-config\.yaml: /
    );
  });

  test('throws when entities.<name>.mask is a string instead of an array', () => {
    const yamlString = 'mode: enforce\nentities:\n  Orders:\n    mask: CreditCard';
    expect(() => parseConfig(yamlString)).toThrow('entities.Orders.mask must be an array, got string');
  });

  test('throws when entities.<name>.allowTools is a string instead of an array', () => {
    const yamlString = 'mode: enforce\nentities:\n  Orders:\n    allowTools: ReadOrders';
    expect(() => parseConfig(yamlString)).toThrow('entities.Orders.allowTools must be an array, got string');
  });

  test('throws when maxRows is not a number', () => {
    const yamlString = 'mode: enforce\nentities:\n  Orders:\n    maxRows: "many"';
    expect(() => parseConfig(yamlString)).toThrow('entities.Orders.maxRows must be a number, got string');
  });

  test('throws when maxRows is negative', () => {
    const yamlString = 'mode: enforce\nentities:\n  Orders:\n    maxRows: -5';
    expect(() => parseConfig(yamlString)).toThrow('entities.Orders.maxRows must not be negative (got -5)');
  });

  test('accepts an empty entities object as valid', () => {
    expect(parseConfig('mode: enforce\nentities: {}')).toEqual({ mode: 'enforce', entities: {} });
  });

  test('accepts a config with no entities key at all', () => {
    expect(parseConfig('mode: enforce')).toEqual({ mode: 'enforce', entities: {} });
  });

  test('accepts an entity with only its name and no mask/maxRows/allowTools', () => {
    const yamlString = 'mode: enforce\nentities:\n  Books:';
    expect(parseConfig(yamlString)).toEqual({
      mode: 'enforce',
      entities: {
        Books: { mask: undefined, maxRows: undefined, allowTools: undefined }
      }
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

  test('reads and parses a real file from disk', () => {
    const filePath = path.join(tmpDir, 'cap-mcp-guard.yaml');
    fs.writeFileSync(filePath, 'mode: observe\nentities:\n  Orders:\n    mask: [CreditCard]\n');

    expect(loadConfig(filePath)).toEqual({
      mode: 'observe',
      entities: { Orders: { mask: ['CreditCard'], maxRows: undefined, allowTools: undefined } }
    });
  });

  test('throws a clear error when the file does not exist', () => {
    const filePath = path.join(tmpDir, 'does-not-exist.yaml');
    expect(() => loadConfig(filePath)).toThrow(`cap-mcp-guard.yaml not found at ${filePath}`);
  });

  test('wraps YAML syntax errors with the real file path', () => {
    const filePath = path.join(tmpDir, 'broken.yaml');
    fs.writeFileSync(filePath, 'mode: [unclosed');

    expect(() => loadConfig(filePath)).toThrow(new RegExp(`^Failed to parse ${filePath.replace(/\\/g, '\\\\')}: `));
  });
});