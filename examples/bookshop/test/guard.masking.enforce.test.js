'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

describe('cap-mcp-guard M4 — enforce mode masks fields on the real response', () => {
  const decisions = [];

  // The on-disk cap-mcp-guard.yaml ships in "observe" mode (see that file's
  // comment); this suite overrides with an explicit inline policyDefinition
  // so enforce/observe can each get their own isolated test file without
  // maintaining two separate YAML fixtures on disk.
  registerCapMcpGuard(cds, {
    policyDefinition: {
      mode: 'enforce',
      entities: { 'CatalogService.Books': { mask: ['price'] } }
    },
    onDecision: (decision) => decisions.push(decision)
  });

  it('replaces price with the mask placeholder in a real OData READ response', async () => {
    const { data } = await GET('/odata/v4/browse/Books');

    expect(data.value.length).to.be.greaterThan(0);
    for (const book of data.value) {
      expect(book.price).to.equal('***MASKED***');
    }
  });

  it('still reports a Decision via onDecision with mode enforce and the masked field', async () => {
    decisions.length = 0;
    await GET('/odata/v4/browse/Books');

    const bookDecision = decisions.find((d) => d.entity === 'CatalogService.Books');
    expect(bookDecision.mode).to.equal('enforce');
    expect(bookDecision.fieldsToMask).to.deep.equal(['price']);
  });
});