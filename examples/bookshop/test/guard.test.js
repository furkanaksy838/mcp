'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

describe('cap-mcp-guard M1 — request interception against the real bookshop service', () => {
  const contexts = [];
  // Explicit no-op policyDefinition: this suite only cares about context
  // building, so it stays independent of whatever cap-mcp-guard.yaml
  // happens to contain (that's covered by the M4 masking test files).
  registerCapMcpGuard(cds, {
    onContext: (context) => contexts.push(context),
    policyDefinition: { mode: 'observe', entities: {} }
  });

  beforeEach(() => {
    contexts.length = 0;
  });

  it('builds a guard context for a real OData READ against CatalogService.Books', async () => {
    const { data } = await GET('/odata/v4/browse/Books');

    expect(data.value.length).to.be.greaterThan(0);

    const bookContexts = contexts.filter((c) => c.entity === 'CatalogService.Books');
    expect(bookContexts.length).to.equal(1);

    const context = bookContexts[0];
    expect(context.operation).to.equal('READ');
    expect(context.rowCount).to.equal(data.value.length);
    expect(context.session).to.be.a('string');
    expect(context.timestamp).to.be.a('string');
    expect(context.durationMs).to.be.a('number');
    expect(context.durationMs).to.be.at.least(0);
  });

  it('resolves the mocked-auth user onto context.user', async () => {
    await GET('/odata/v4/browse/Books');
    expect(contexts[0].user).to.equal('anonymous');
  });

  it('never blocks or mutates the actual response — guard only observes', async () => {
    const { data, status } = await GET('/odata/v4/browse/Books');
    expect(status).to.equal(200);
    expect(data.value[0]).to.have.property('title');
  });
});