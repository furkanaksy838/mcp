'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { trace } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

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

/** Writes a package.json with a "cap-mcp-guard" key into tmpDir. */
function writeConfig(tmpDir, capMcpGuardConfig) {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture', 'cap-mcp-guard': capMcpGuardConfig }));
}

describe('registerCapMcpGuard', () => {
  let tmpDir;
  let logSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-adapter-'));
    // Audit logging is on by default (see the describe block below); mute
    // it here so unrelated tests don't spam console output, and so the
    // dedicated audit tests can assert against it explicitly.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  test('loads the "cap-mcp-guard" key from package.json at cds.root and enforces it on served services', async () => {
    writeConfig(tmpDir, { mode: 'enforce', entities: { Orders: { mask: ['CreditCard'] } } });

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

  test('propagates the error when package.json exists but has malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json');

    const cds = createFakeCds(tmpDir, {});

    expect(() => registerCapMcpGuard(cds)).toThrow(/^Failed to parse /);
  });

  test('refuses to start (instead of silently pass-through) when a legacy cap-mcp-guard.yaml is found and package.json has no config', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Orders:\n    mask:\n      - CreditCard\n'
    );
    // no package.json at all in tmpDir — matches "not configured" from loadConfig's perspective

    const cds = createFakeCds(tmpDir, {});

    expect(() => registerCapMcpGuard(cds)).toThrow(/cap-mcp-guard\.yaml.*no longer|not.*read.*since 0\.3\.0/i);
  });

  test('still falls back to pass-through, with the usual warning, when no legacy yaml file exists either', () => {
    const cds = createFakeCds(tmpDir, {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => registerCapMcpGuard(cds)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no config found'));
    } finally {
      warn.mockRestore();
    }
  });

  test('an explicit options.policyDefinition takes precedence over the config on disk', async () => {
    writeConfig(tmpDir, { mode: 'enforce', entities: { Orders: { mask: ['CreditCard'] } } });

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

  describe('policyDefinition.services allowlist', () => {
    test('attaches only to services named in "services", leaving others completely untouched', async () => {
      const Orders = createFakeService();
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders, Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: {
          mode: 'enforce',
          entities: { Orders: { mask: ['CreditCard'] }, Customers: { mask: ['IBAN'] } },
          services: ['Orders']
        }
      });
      cds.fireServed();

      const orderResults = [{ ID: 1, CreditCard: '4111-...' }];
      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, orderResults);
      expect(orderResults).toEqual([{ ID: 1, CreditCard: '***MASKED***' }]);

      const customerResults = [{ ID: 1, IBAN: 'DE00-...' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, customerResults);
      expect(customerResults).toEqual([{ ID: 1, IBAN: 'DE00-...' }]);
      expect(logSpy).toHaveBeenCalledTimes(1); // only Orders' audit entry — Customers was never attached to
    });

    test('attaches to every served service when "services" is omitted (default, unchanged behavior)', async () => {
      const Orders = createFakeService();
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders, Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: { mode: 'enforce', entities: { Customers: { mask: ['IBAN'] } } }
      });
      cds.fireServed();

      const customerResults = [{ ID: 1, IBAN: 'DE00-...' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, customerResults);
      expect(customerResults).toEqual([{ ID: 1, IBAN: '***MASKED***' }]);
    });
  });

  describe('policyDefinition.users allowlist (same service, different identities)', () => {
    test('the AI technical user gets masked data; a human UI user on the SAME service gets real data', async () => {
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: {
          mode: 'enforce',
          entities: { Customers: { mask: ['IBAN'] } },
          users: ['mcp-agent-technical-user']
        }
      });
      cds.fireServed();

      const aiResults = [{ ID: 1, IBAN: 'DE89370400440532013000' }];
      await Customers.simulateRead(
        { event: 'READ', entity: 'Customers', user: { id: 'mcp-agent-technical-user' } },
        aiResults
      );
      expect(aiResults).toEqual([{ ID: 1, IBAN: '***MASKED***' }]);

      const uiResults = [{ ID: 1, IBAN: 'DE89370400440532013000' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers', user: { id: 'ayse@sirket.com' } }, uiResults);
      expect(uiResults).toEqual([{ ID: 1, IBAN: 'DE89370400440532013000' }]);
    });

    test('a request with no authenticated user at all is passed through when "users" is set', async () => {
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: {
          mode: 'enforce',
          entities: { Customers: { mask: ['IBAN'] } },
          users: ['mcp-agent-technical-user']
        }
      });
      cds.fireServed();

      const results = [{ ID: 1, IBAN: 'DE89370400440532013000' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, results);
      expect(results).toEqual([{ ID: 1, IBAN: 'DE89370400440532013000' }]);
    });
  });

  describe('policyDefinition.entities.<name>.pseudonymize', () => {
    test('replaces the real IBAN with a deterministic fake one, never the real value', async () => {
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: {
          mode: 'enforce',
          entities: { Customers: { pseudonymize: [{ field: 'IBAN', type: 'iban' }] } }
        },
        pseudonymSecret: 'test-secret'
      });
      cds.fireServed();

      const firstRead = [{ ID: 1, IBAN: 'DE89370400440532013000' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, firstRead);

      const secondRead = [{ ID: 1, IBAN: 'DE89370400440532013000' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, secondRead);

      expect(firstRead[0].IBAN).not.toBe('DE89370400440532013000');
      expect(firstRead[0].IBAN).toBe(secondRead[0].IBAN); // deterministic across separate requests

      const otherCustomerRead = [{ ID: 2, IBAN: 'FR1420041010050500013M02606' }];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, otherCustomerRead);
      expect(otherCustomerRead[0].IBAN).not.toBe(firstRead[0].IBAN); // different real value -> different pseudonym
    });

    test('type "custom" replaces the real value with the configured literal, for every row', async () => {
      const Customers = createFakeService();
      const cds = createFakeCds(tmpDir, { Customers });

      registerCapMcpGuard(cds, {
        policyDefinition: {
          mode: 'enforce',
          entities: {
            Customers: { pseudonymize: [{ field: 'Email', type: 'custom', value: 'hidden@example.com' }] }
          }
        }
      });
      cds.fireServed();

      const results = [
        { ID: 1, Email: 'alice@example.com' },
        { ID: 2, Email: 'bob@example.com' }
      ];
      await Customers.simulateRead({ event: 'READ', entity: 'Customers' }, results);

      expect(results).toEqual([
        { ID: 1, Email: 'hidden@example.com' },
        { ID: 2, Email: 'hidden@example.com' }
      ]);
    });

    test('does not require a pseudonym secret when every entry is type "custom"', () => {
      const savedEnv = process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
      delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;

      try {
        const cds = createFakeCds(tmpDir, {});

        expect(() =>
          registerCapMcpGuard(cds, {
            policyDefinition: {
              mode: 'enforce',
              entities: {
                Customers: { pseudonymize: [{ field: 'Email', type: 'custom', value: 'hidden@example.com' }] }
              }
            }
          })
        ).not.toThrow();
      } finally {
        if (savedEnv === undefined) delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
        else process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET = savedEnv;
      }
    });

    test('still requires a secret when a "custom" entry is mixed with a non-"custom" one', () => {
      const savedEnv = process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
      delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;

      try {
        const cds = createFakeCds(tmpDir, {});

        expect(() =>
          registerCapMcpGuard(cds, {
            policyDefinition: {
              mode: 'enforce',
              entities: {
                Customers: {
                  pseudonymize: [
                    { field: 'Email', type: 'custom', value: 'hidden@example.com' },
                    { field: 'IBAN', type: 'iban' }
                  ]
                }
              }
            }
          })
        ).toThrow('CAP_MCP_GUARD_PSEUDONYM_SECRET env var (or options.pseudonymSecret) is required');
      } finally {
        if (savedEnv === undefined) delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
        else process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET = savedEnv;
      }
    });

    test('throws synchronously at registration when pseudonymize is configured but no secret is available', () => {
      const savedEnv = process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
      delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;

      try {
        const cds = createFakeCds(tmpDir, {});

        expect(() =>
          registerCapMcpGuard(cds, {
            policyDefinition: {
              mode: 'enforce',
              entities: { Customers: { pseudonymize: [{ field: 'IBAN', type: 'iban' }] } }
            }
          })
        ).toThrow('CAP_MCP_GUARD_PSEUDONYM_SECRET env var (or options.pseudonymSecret) is required');
      } finally {
        if (savedEnv === undefined) delete process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;
        else process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET = savedEnv;
      }
    });
  });

  describe('audit logging (M5)', () => {
    test('logs an audit entry to stdout by default for every request', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} } });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.context.entity).toBe('Orders');
      expect(entry.decision.mode).toBe('observe');
    });

    test('also appends to options.audit.filePath when given', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });
      const auditFile = path.join(tmpDir, 'audit.log');

      registerCapMcpGuard(cds, {
        policyDefinition: { mode: 'observe', entities: {} },
        audit: { filePath: auditFile }
      });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).context.entity).toBe('Orders');
    });

    test('picks up audit.filePath from the "cap-mcp-guard" key in package.json, with no options.audit at all', async () => {
      const auditFile = path.join(tmpDir, 'audit.log');
      writeConfig(tmpDir, {
        mode: 'observe',
        entities: {},
        audit: { filePath: auditFile }
      });

      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds); // no options at all — matches cds-plugin.js's auto-discovery call
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).context.entity).toBe('Orders');
    });

    test('an explicit options.audit still overrides whatever package.json configures', async () => {
      writeConfig(tmpDir, { mode: 'observe', entities: {}, audit: { filePath: path.join(tmpDir, 'from-config.log') } });

      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });
      const overrideFile = path.join(tmpDir, 'from-options.log');

      registerCapMcpGuard(cds, { audit: { filePath: overrideFile } });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(fs.existsSync(overrideFile)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'from-config.log'))).toBe(false);
    });

    test('options.audit: false disables audit logging entirely', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} }, audit: false });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(logSpy).not.toHaveBeenCalled();
    });

    test('a caller-supplied onDecision still runs alongside the built-in audit log', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });
      const onDecision = jest.fn();

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} }, onDecision });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision.mock.calls[0][0].mode).toBe('observe');
    });

    test('options.audit: false still runs a caller-supplied onDecision directly', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });
      const onDecision = jest.fn();

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} }, audit: false, onDecision });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(logSpy).not.toHaveBeenCalled();
      expect(onDecision).toHaveBeenCalledTimes(1);
    });
  });

  describe('OTel span export (M6)', () => {
    let memoryExporter;
    let provider;

    beforeEach(() => {
      memoryExporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
      trace.setGlobalTracerProvider(provider);
    });

    afterEach(async () => {
      memoryExporter.reset();
      await provider.shutdown();
      trace.disable();
    });

    test('exports a span to the globally registered OTel SDK by default, for every request', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} } });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('READ Orders');
    });

    test('options.otel: false disables span export entirely', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} }, otel: false });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });

    test('an injected options.otel.tracer is used instead of the global tracer', async () => {
      const customExporter = new InMemorySpanExporter();
      const customProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(customExporter)] });
      const customTracer = customProvider.getTracer('custom');

      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });

      registerCapMcpGuard(cds, {
        policyDefinition: { mode: 'observe', entities: {} },
        otel: { tracer: customTracer }
      });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
      expect(customExporter.getFinishedSpans()).toHaveLength(1);

      await customProvider.shutdown();
    });

    test('audit logging, OTel export, and a caller-supplied onDecision all run together', async () => {
      const Orders = createFakeService();
      const cds = createFakeCds(tmpDir, { Orders });
      const onDecision = jest.fn();

      registerCapMcpGuard(cds, { policyDefinition: { mode: 'observe', entities: {} }, onDecision });
      cds.fireServed();

      await Orders.simulateRead({ event: 'READ', entity: 'Orders' }, [{ ID: 1 }]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(memoryExporter.getFinishedSpans()).toHaveLength(1);
      expect(onDecision).toHaveBeenCalledTimes(1);
    });
  });
});