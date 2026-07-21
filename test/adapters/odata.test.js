'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { trace } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const { odataMcpGuard } = require('../../lib/adapters/odata');

/** Minimal duck-typed Express-style request/response pair — no Express involved. */
function createFakeReqRes({
  method = 'GET',
  url = '/odata/v4/browse/Books',
  headers = {},
  user,
  body,
  responseHeaders = {}
} = {}) {
  const req = { method, url, headers, user, body };
  const resHeaders = { ...responseHeaders };
  const res = {
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    getHeader(name) {
      return resHeaders[name.toLowerCase()];
    },
    setHeader(name, value) {
      resHeaders[name.toLowerCase()] = value;
    }
  };
  return { req, res };
}

async function runRequest(middleware, reqResOptions, responseBody) {
  const { req, res } = createFakeReqRes(reqResOptions);
  let nextCalled = false;

  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  res.json(responseBody);
  return { req, res, nextCalled };
}

async function runSendRequest(middleware, reqResOptions, responseBody) {
  const { req, res } = createFakeReqRes(reqResOptions);
  let nextCalled = false;

  await new Promise((resolve) => {
    middleware(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  res.send(responseBody);
  return { req, res, nextCalled };
}

describe('odataMcpGuard', () => {
  let tmpDir;
  let logSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-odata-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  test('loads cap-mcp-guard.yaml from cwd and masks a V4 collection response in enforce mode', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
    );

    const middleware = odataMcpGuard({ cwd: tmpDir });
    const { res } = await runRequest(middleware, {}, { value: [{ ID: 1, price: 9.99 }] });

    expect(res.body).toEqual({ value: [{ ID: 1, price: '***MASKED***' }] });
  });

  test('masks a V2 single-entity response in enforce mode', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Products:\n    mask: [cost]\n'
    );

    const middleware = odataMcpGuard({ cwd: tmpDir });
    const { res } = await runRequest(
      middleware,
      { url: '/sap/opu/odata/sap/ZGW_SRV/Products(1)' },
      { d: { ID: 1, cost: 42 } }
    );

    expect(res.body).toEqual({ d: { ID: 1, cost: '***MASKED***' } });
  });

  test('does not mask in observe mode', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: observe\nentities:\n  Books:\n    mask: [price]\n'
    );

    const middleware = odataMcpGuard({ cwd: tmpDir });
    const { res } = await runRequest(middleware, {}, { value: [{ ID: 1, price: 9.99 }] });

    expect(res.body).toEqual({ value: [{ ID: 1, price: 9.99 }] });
  });

  test('falls back to a pass-through policy when no config file exists, without throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const middleware = odataMcpGuard({ cwd: tmpDir });
      const { res } = await runRequest(middleware, {}, { value: [{ ID: 1, price: 9.99 }] });

      expect(res.body).toEqual({ value: [{ ID: 1, price: 9.99 }] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no config found'));
    } finally {
      warn.mockRestore();
    }
  });

  test('propagates the error when the config file exists but has malformed YAML', () => {
    fs.writeFileSync(path.join(tmpDir, 'cap-mcp-guard.yaml'), 'mode: [unclosed');

    expect(() => odataMcpGuard({ cwd: tmpDir })).toThrow(/^Failed to parse /);
  });

  test('an explicit options.policyDefinition takes precedence over the file on disk', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
    );

    const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
    const { res } = await runRequest(middleware, {}, { value: [{ ID: 1, price: 9.99 }] });

    expect(res.body).toEqual({ value: [{ ID: 1, price: 9.99 }] });
  });

  test('does not mask a $batch response body, but still calls next()', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'cap-mcp-guard.yaml'),
      'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
    );

    const middleware = odataMcpGuard({ cwd: tmpDir });
    const { res, nextCalled } = await runRequest(
      middleware,
      { method: 'POST', url: '/odata/v4/browse/$batch' },
      { some: 'multipart-mixed-payload-stand-in' }
    );

    expect(nextCalled).toBe(true);
    expect(res.body).toEqual({ some: 'multipart-mixed-payload-stand-in' });
  });

  test('passes every request through unguarded and warns once when res.json is unavailable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      const req1 = { method: 'GET', url: '/odata/v4/browse/Books', headers: {} };
      const req2 = { method: 'GET', url: '/odata/v4/browse/Books', headers: {} };
      const res = {};

      await new Promise((resolve) => middleware(req1, res, resolve));
      await new Promise((resolve) => middleware(req2, res, resolve));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('res.json is not available'));
    } finally {
      warn.mockRestore();
    }
  });

  describe('audit logging', () => {
    test('logs an audit entry to stdout by default for every request', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.context.entity).toBe('Books');
      expect(entry.context.operation).toBe('READ');
      expect(entry.decision.mode).toBe('observe');
    });

    test('still audits a $batch request, with an undefined entity', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(middleware, { method: 'POST', url: '/odata/v4/browse/$batch' }, {});

      expect(logSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.context.entity).toBeUndefined();
      expect(entry.context.rowCount).toBeUndefined();
    });

    test('options.audit: false disables audit logging entirely', async () => {
      const middleware = odataMcpGuard({
        cwd: tmpDir,
        policyDefinition: { mode: 'observe', entities: {} },
        audit: false
      });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      expect(logSpy).not.toHaveBeenCalled();
    });

    test('a caller-supplied onDecision still runs alongside the built-in audit log', async () => {
      const onDecision = jest.fn();
      const middleware = odataMcpGuard({
        cwd: tmpDir,
        policyDefinition: { mode: 'observe', entities: {} },
        onDecision
      });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision.mock.calls[0][0].mode).toBe('observe');
    });
  });

  describe('OTel span export', () => {
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
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('READ Books');
    });

    test('options.otel: false disables span export entirely', async () => {
      const middleware = odataMcpGuard({
        cwd: tmpDir,
        policyDefinition: { mode: 'observe', entities: {} },
        otel: false
      });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      expect(memoryExporter.getFinishedSpans()).toHaveLength(0);
    });
  });

  describe('$expand-aware masking', () => {
    test('masks a $expand-ed nested entity when cap-mcp-guard.yaml keys it by nav-property name', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n  author:\n    mask: [dateOfDeath]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const { res } = await runRequest(
        middleware,
        { url: '/odata/v4/browse/Books?$expand=author' },
        {
          value: [{ ID: 1, price: 9.99, author: { ID: 10, name: 'Bronte', dateOfDeath: '1855-03-31' } }]
        }
      );

      expect(res.body.value[0].price).toBe('***MASKED***');
      expect(res.body.value[0].author.dateOfDeath).toBe('***MASKED***');
      expect(res.body.value[0].author.name).toBe('Bronte');
    });

    test('emits one audit entry per group (root + each expanded nav) when $expand is used', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(
        middleware,
        { url: '/odata/v4/browse/Books?$expand=author' },
        { value: [{ ID: 1, author: { ID: 10, name: 'Bronte' } }] }
      );

      expect(logSpy).toHaveBeenCalledTimes(2);
      const entities = logSpy.mock.calls.map((call) => JSON.parse(call[0]).context.entity);
      expect(entities).toEqual(['Books', 'author']);
    });

    test('with no $expand, behaves exactly as before (one group, one audit entry)', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(middleware, {}, { value: [{ ID: 1 }] });

      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('EDM-based entity resolution (metadataXml)', () => {
    const METADATA = `
      <edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
        <edmx:DataServices>
          <Schema Namespace="CatalogService" xmlns="http://docs.oasis-open.org/odata/ns/edm">
            <EntityType Name="Books">
              <Key><PropertyRef Name="ID"/></Key>
              <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
              <NavigationProperty Name="author" Type="CatalogService.Authors" Nullable="false"/>
            </EntityType>
            <EntityType Name="Authors">
              <Key><PropertyRef Name="ID"/></Key>
              <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
              <Property Name="dateOfDeath" Type="Edm.Date"/>
            </EntityType>
            <EntityContainer Name="EntityContainer">
              <EntitySet Name="Books" EntityType="CatalogService.Books"/>
              <EntitySet Name="Authors" EntityType="CatalogService.Authors"/>
            </EntityContainer>
          </Schema>
        </edmx:DataServices>
      </edmx:Edmx>
    `;

    test('resolves a deep nav-property path to its real target entity, not the literal segment name', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Authors:\n    mask: [dateOfDeath]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir, metadataXml: METADATA });
      const { res } = await runRequest(
        middleware,
        { url: '/odata/v4/browse/Books(201)/author' },
        { '@odata.context': '$metadata#Authors/$entity', ID: 10, dateOfDeath: '1855-03-31' }
      );

      expect(res.body.dateOfDeath).toBe('***MASKED***');
    });

    test('resolves a $expand-ed nav property to its real entity-set name via the edm', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Authors:\n    mask: [dateOfDeath]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir, metadataXml: METADATA });
      const { res } = await runRequest(
        middleware,
        { url: '/odata/v4/browse/Books?$expand=author' },
        { value: [{ ID: 1, author: { ID: 10, dateOfDeath: '1855-03-31' } }] }
      );

      expect(res.body.value[0].author.dateOfDeath).toBe('***MASKED***');
    });
  });

  describe('OData V4 JSON $batch', () => {
    test('masks each sub-request individually when req.body is a pre-parsed V4 JSON batch', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n  Authors:\n    mask: [dateOfDeath]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const { res } = await runRequest(
        middleware,
        {
          method: 'POST',
          url: '/odata/v4/browse/$batch',
          body: {
            requests: [
              { id: '1', method: 'GET', url: '/odata/v4/browse/Books' },
              { id: '2', method: 'GET', url: '/odata/v4/browse/Authors(10)' }
            ]
          }
        },
        {
          responses: [
            { id: '1', status: 200, body: { value: [{ ID: 1, price: 9.99 }] } },
            {
              id: '2',
              status: 200,
              body: { '@odata.context': '$metadata#Authors/$entity', ID: 10, dateOfDeath: '1855-03-31' }
            }
          ]
        }
      );

      expect(res.body.responses[0].body.value[0].price).toBe('***MASKED***');
      expect(res.body.responses[1].body.dateOfDeath).toBe('***MASKED***');
    });

    test('audits each sub-request separately, by its own resolved entity', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runRequest(
        middleware,
        {
          method: 'POST',
          url: '/odata/v4/browse/$batch',
          body: {
            requests: [
              { id: '1', method: 'GET', url: '/odata/v4/browse/Books' },
              { id: '2', method: 'GET', url: '/odata/v4/browse/Authors' }
            ]
          }
        },
        {
          responses: [
            { id: '1', status: 200, body: { value: [{ ID: 1 }] } },
            { id: '2', status: 200, body: { value: [{ ID: 10 }] } }
          ]
        }
      );

      expect(logSpy).toHaveBeenCalledTimes(2);
      const entities = logSpy.mock.calls.map((call) => JSON.parse(call[0]).context.entity);
      expect(entities).toEqual(['Books', 'Authors']);
    });

    test('falls back to the legacy unparsed-batch behavior when req.body is not a V4 JSON batch shape', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const { res, nextCalled } = await runRequest(
        middleware,
        { method: 'POST', url: '/odata/v4/browse/$batch' },
        { note: 'stand-in for a real multipart/mixed batch body' }
      );

      expect(nextCalled).toBe(true);
      expect(res.body).toEqual({ note: 'stand-in for a real multipart/mixed batch body' });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0][0]).context.entity).toBeUndefined();
    });
  });

  describe('classic OData V2 multipart/mixed $batch', () => {
    const REQUEST_BODY = [
      '--batch_1',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'GET Books HTTP/1.1',
      'Accept: application/json',
      '',
      '--batch_1',
      'Content-Type: multipart/mixed; boundary=changeset_1',
      '',
      '--changeset_1',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'POST Authors HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"name":"Bronte"}',
      '--changeset_1--',
      '--batch_1--'
    ].join('\r\n');

    // classic V2 batch responses use the V2 JSON envelope ({"d": ...}),
    // not the bare V4-style object
    function responseBody({ booksPrice = 9.99, authorsDateOfDeath = '1855-03-31' } = {}) {
      return [
        '--batchresponse_1',
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        '',
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        '',
        `{"d":{"results":[{"ID":1,"price":${booksPrice}}]}}`,
        '--batchresponse_1',
        'Content-Type: multipart/mixed; boundary=changesetresponse_1',
        '',
        '--changesetresponse_1',
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        '',
        'HTTP/1.1 201 Created',
        'Content-Type: application/json',
        '',
        `{"d":{"ID":10,"name":"Bronte","dateOfDeath":"${authorsDateOfDeath}"}}`,
        '--changesetresponse_1--',
        '--batchresponse_1--'
      ].join('\r\n');
    }

    test('masks a single GET response and a nested changeset response', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n  Authors:\n    mask: [dateOfDeath]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const { res } = await runSendRequest(
        middleware,
        {
          method: 'POST',
          url: '/sap/opu/odata/sap/ZGW_SRV/$batch',
          headers: { 'content-type': 'multipart/mixed; boundary=batch_1' },
          body: Buffer.from(REQUEST_BODY, 'utf8'),
          responseHeaders: { 'content-type': 'multipart/mixed; boundary=batchresponse_1' }
        },
        responseBody()
      );

      const { parseBatchResponses } = require('../../lib/core/odata-batch');
      const parsed = parseBatchResponses(res.body, 'batchresponse_1');

      expect(JSON.parse(parsed[0].body)).toEqual({ d: { results: [{ ID: 1, price: '***MASKED***' }] } });
      expect(JSON.parse(parsed[1].parts[0].body)).toEqual({
        d: { ID: 10, name: 'Bronte', dateOfDeath: '***MASKED***' }
      });
    });

    test('audits the single GET and the changeset sub-request separately', async () => {
      const middleware = odataMcpGuard({ cwd: tmpDir, policyDefinition: { mode: 'observe', entities: {} } });
      await runSendRequest(
        middleware,
        {
          method: 'POST',
          url: '/sap/opu/odata/sap/ZGW_SRV/$batch',
          headers: { 'content-type': 'multipart/mixed; boundary=batch_1' },
          body: Buffer.from(REQUEST_BODY, 'utf8'),
          responseHeaders: { 'content-type': 'multipart/mixed; boundary=batchresponse_1' }
        },
        responseBody()
      );

      expect(logSpy).toHaveBeenCalledTimes(2);
      const entities = logSpy.mock.calls.map((call) => JSON.parse(call[0]).context.entity);
      expect(entities).toEqual(['Books', 'Authors']);
    });

    test('falls back to the legacy unparsed-batch behavior when req.body was never buffered', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const rawBody = responseBody();
      const { res, nextCalled } = await runSendRequest(
        middleware,
        {
          method: 'POST',
          url: '/sap/opu/odata/sap/ZGW_SRV/$batch',
          headers: { 'content-type': 'multipart/mixed; boundary=batch_1' },
          // req.body intentionally left undefined, as if no raw body-parser ran
          responseHeaders: { 'content-type': 'multipart/mixed; boundary=batchresponse_1' }
        },
        rawBody
      );

      expect(nextCalled).toBe(true);
      expect(res.body).toBe(rawBody); // untouched — nothing was masked
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0][0]).context.entity).toBeUndefined();
    });

    test('does not process the same batch twice when res.json calls through to a patched res.send', async () => {
      // Mimics Express's real res.json(), which internally calls this.send(...)
      fs.writeFileSync(
        path.join(tmpDir, 'cap-mcp-guard.yaml'),
        'mode: enforce\nentities:\n  Books:\n    mask: [price]\n'
      );

      const middleware = odataMcpGuard({ cwd: tmpDir });
      const req = {
        method: 'POST',
        url: '/odata/v4/browse/$batch',
        headers: {},
        body: { requests: [{ id: '1', method: 'GET', url: '/odata/v4/browse/Books' }] }
      };
      const res = {
        json(body) {
          return this.send(body);
        },
        send(body) {
          this.body = body;
          return this;
        },
        getHeader() {
          return undefined;
        }
      };

      await new Promise((resolve) => middleware(req, res, resolve));
      res.json({ responses: [{ id: '1', status: 200, body: { value: [{ ID: 1, price: 9.99 }] } }] });

      expect(res.body.responses[0].body.value[0].price).toBe('***MASKED***');
      expect(logSpy).toHaveBeenCalledTimes(1); // not double-audited
    });
  });
});
