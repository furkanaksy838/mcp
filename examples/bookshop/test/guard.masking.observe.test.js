'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

describe('cap-mcp-guard M4 — observe mode never touches the real response', () => {
  const decisions = [];

  // Same mask configured as the enforce test, but mode: observe — proves
  // the Decision is still computed while the actual response stays
  // untouched. See guard.masking.enforce.test.js for the enforce case.
  registerCapMcpGuard(cds, {
    policyDefinition: {
      mode: 'observe',
      entities: { 'CatalogService.Books': { mask: ['price'] } }
    },
    onDecision: (decision) => decisions.push(decision)
  });

  it('returns the original, unmasked price in a real OData READ response', async () => {
    const { data } = await GET('/odata/v4/browse/Books');

    expect(data.value.length).to.be.greaterThan(0);
    for (const book of data.value) {
      // OData v4 serializes Edm.Decimal as a string (e.g. "11.11") to
      // preserve precision — assert it's a real decimal, not our placeholder.
      expect(book.price).to.not.equal('***MASKED***');
      expect(book.price).to.match(/^\d+\.\d+$/);
    }
  });

  it('still reports a Decision via onDecision with mode observe and the field it would have masked', async () => {
    decisions.length = 0;
    await GET('/odata/v4/browse/Books');

    const bookDecision = decisions.find((d) => d.entity === 'CatalogService.Books');
    expect(bookDecision.mode).to.equal('observe');
    expect(bookDecision.fieldsToMask).to.deep.equal(['price']);
  });
});