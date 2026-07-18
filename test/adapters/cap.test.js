'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerCapMcpGuard } = require('../../lib/adapters/cap');

/** Minimal duck-typed CAP service — no @sap/cds involved. */
function createFakeService() {
  const afterHandlers = [];
  return {
    before() {},
    after(event, handler) {
      afterHandlers.push(handler);
    },
    async simulateRead(req, results) {
      for (const handler of afterHandlers) await handler(results, req);
    }
  };
}

/** Minimal duck-typed `cds` facade — enough for registerCapMcpGuard/attachInterceptor. */
function createFakeCds(root, services) {
  const listeners = [];
  class ApplicationService {}
  for (const srv of Object.values(services)) Object.setPrototypeOf(srv, ApplicationService.prototype);

  return {
    root,
    services,
    ApplicationService,
    on(event, handler) {
      if (event === 'served') listeners.push(handler);
    },
    fireServed() {
      listeners.forEach((fn) => fn());
    }
  };
}

describe('registerCapMcpGuard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-adapter-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads cap-mcp-guard.yaml from cds.root and enforces it on served services', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Orders:\n    mask: [CreditCard]\n'
    );

    const Orders = createFakeService();
    const cds = createFakeCds(tmpDir, { Orders });

    registerCapMcpGuard(cds);
    cds.fireServed();

    const results = [{ ID: 1, CreditCard: '4111-...' }];
    await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, results);

    expect(results).toEqual([{ ID: 1, CreditCard: '***MASKED***' }]);
  });

  test('falls back to a pass-through PolicyDefinition when no config file exists, without throwing', async () => {
    const Orders = createFakeService();
    const cds = createFakeCds(tmpDir, { Orders });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => registerCapMcpGuard(cds)).not.toThrow();
      cds.fireServed();

      const results = [{ ID: 1, CreditCard: '4111-...' }];
      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, results);

      // pass-through: nothing masked, response untouched
      expect(results).toEqual([{ ID: 1, CreditCard: '4111-...' }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no config found'));
    } finally {
      warn.mockRestore();
    }
  });

  test('propagates the error when the config file exists but has malformed YAML', () => {
    fs.writeFileSync(path.join(tmpDir, 'cap-mcp-guard.yaml'), 'mode: [unclosed');

    const cds = createFakeCds(tmpDir, {});

    expect(() => registerCapMcpGuard(cds)).toThrow(/^Failed to parse /);
  });

  test('an explicit options.policyDefinition takes precedence over the file on disk', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Orders:\n    mask: [CreditCard]\n'
    );

    const Orders = createFakeService();
    const cds = createFakeCds(tmpDir, { Orders });

    registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} } });
    cds.fireServed();

    const results = [{ ID: 1, CreditCard: '4111-...' }];
    await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, results);

    expect(results).toEqual([{ ID: 1, CreditCard: '4111-...' }]);
  });

  test('only attaches to instances of cds.ApplicationService', () => {
    const Orders = createFakeService();
    const notAnAppService = { before() {}, after() {} };
    const cds = createFakeCds(tmpDir, { Orders });
    cds.services.db = notAnAppService;

    expect(() => {
      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} } });
      cds.fireServed();
    }).not.toThrow();
  });
});