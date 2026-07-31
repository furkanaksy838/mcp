'use strict';

const cds = require('@sap/cds');
const { GET, PATCH, expect } = cds.test(__dirname + '/..');

// Deliberately no registerCapMcpGuard() call in this suite: every other bookshop test injects
// an explicit policyDefinition, which bypasses both of the paths a real project actually uses.
// This one exercises them end to end — cds-plugin.js auto-discovery reading the
// "cap-mcp-guard" key from package.json (here: nothing but `mode`), plus the @mcp.policy
// annotations compiled out of the .cds model.
//
// It covers both agent-facing shapes the example ships, and the one thing they have in common:
// the annotation sits on what the AGENT reads, never on the db entity, so the UI's own
// projections carry no policy and are left alone. No "services"/"users" scoping involved.
describe('cap-mcp-guard — @mcp.policy on the agent-facing projections only', () => {
  describe('approach 1: a dedicated service (AgentService)', () => {
    it('masks the annotated field', async () => {
      const { data } = await GET('/odata/v4/agent/Books');

      expect(data.value.length).to.be.greaterThan(0);
      for (const book of data.value) {
        expect(book.price).to.equal('***MASKED***');
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

  describe('approach 2: a separate entity inside the UI\'s own service (CatalogService.AgentBooks)', () => {
    it('masks the annotated field', async () => {
      const { data } = await GET('/odata/v4/browse/AgentBooks');

      expect(data.value.length).to.be.greaterThan(0);
      for (const book of data.value) {
        expect(book.price).to.equal('***MASKED***');
      }
    });

    it('is @readonly — an agent cannot write back the value it just read masked', async () => {
      try {
        await PATCH('/odata/v4/browse/AgentBooks(201)', { stock: 1 });
        expect.fail('PATCH against a @readonly entity should have been rejected');
      } catch (err) {
        expect(err.response.status).to.equal(405);
      }
    });
  });

  describe('the UI', () => {
    it('reads the real value from its own entity in the same service', async () => {
      const { data } = await GET('/odata/v4/browse/Books');

      expect(data.value.length).to.be.greaterThan(0);
      for (const book of data.value) {
        // OData v4 serializes Edm.Decimal as a string (e.g. "11.11") to preserve precision.
        expect(book.price).to.not.equal('***MASKED***');
        expect(book.price).to.match(/^\d+\.\d+$/);
      }
    });

    it('reads the real value through ListOfBooks too', async () => {
      const { data } = await GET('/odata/v4/browse/ListOfBooks');

      expect(data.value.length).to.be.greaterThan(0);
      for (const book of data.value) {
        expect(book.price).to.not.equal('***MASKED***');
      }
    });

    it('serves the same row masked and unmasked side by side, from one table', async () => {
      const agent = await GET('/odata/v4/browse/AgentBooks(201)?$select=ID,title,price');
      const ui = await GET('/odata/v4/browse/Books(201)?$select=ID,title,price');

      expect(agent.data.title).to.equal(ui.data.title);
      expect(agent.data.price).to.equal('***MASKED***');
      expect(ui.data.price).to.match(/^\d+\.\d+$/);
    });
  });
});
