'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

// Deliberately no registerCapMcpGuard() call in this suite: every other bookshop test
// injects an explicit policyDefinition, which bypasses both of the paths a real project
// actually uses. This one exercises them end to end — cds-plugin.js auto-discovery reading
// the "cap-mcp-guard" key from package.json, plus the @mcp.policy annotations compiled out
// of db/schema.cds — and asserts the split those two produce together: the agent-facing
// service is masked, the UI's service serving the very same rows is not.
describe('cap-mcp-guard — @mcp.policy annotations, scoped to the agent-facing service', () => {
  it('masks the annotated field on AgentService, which is in "services"', async () => {
    const { data } = await GET('/odata/v4/agent/Books');

    expect(data.value.length).to.be.greaterThan(0);
    for (const book of data.value) {
      expect(book.price).to.equal('***MASKED***');
    }
  });

  it('leaves the same field untouched on CatalogService, which is not in "services"', async () => {
    const { data } = await GET('/odata/v4/browse/Books');

    expect(data.value.length).to.be.greaterThan(0);
    for (const book of data.value) {
      // OData v4 serializes Edm.Decimal as a string (e.g. "11.11") to preserve precision.
      expect(book.price).to.not.equal('***MASKED***');
      expect(book.price).to.match(/^\d+\.\d+$/);
    }
  });

  it('applies annotations from a second entity as well', async () => {
    const { data } = await GET('/odata/v4/agent/Authors');

    const known = data.value.filter((author) => author.placeOfDeath !== null);
    expect(known.length).to.be.greaterThan(0);
    for (const author of known) {
      expect(author.placeOfDeath).to.equal('***MASKED***');
    }
  });

  it('does not mask a field that carries no annotation', async () => {
    const { data } = await GET('/odata/v4/agent/Books');

    for (const book of data.value) {
      expect(book.title).to.not.equal('***MASKED***');
      expect(book.stock).to.be.a('number');
    }
  });
});
