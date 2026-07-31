'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

// The third way to separate agent from human, after the two in guard.annotations.test.js
// (own service / own entity): keep one service AND one entity, and split on CAP's own
// authenticated req.user.id via "users". Same endpoint for both callers.
//
// The policy is inlined here rather than annotated in the model on purpose: the example's
// annotations sit on the agent-facing projections (AgentService.Books,
// CatalogService.AgentBooks), and this suite is about masking CatalogService.Books — the
// entity the UI itself reads — for one identity only. That is the whole point of "users":
// it is what you reach for when there is no separate projection to annotate.
describe('cap-mcp-guard — one service, one entity, agent and human separated by identity', () => {
  const decisions = [];

  registerCapMcpGuard(cds, {
    policyDefinition: {
      mode: 'enforce',
      users: ['mcp-agent'],
      entities: { 'CatalogService.Books': { mask: ['price'] } }
    },
    onDecision: (decision) => decisions.push(decision),
    audit: false // this suite is about the identity split, not about log output
  });

  const as = (username) => ({ auth: { username, password: '' } });
  const URL = '/odata/v4/browse/Books(201)?$select=ID,title,price';

  beforeEach(() => {
    decisions.length = 0;
  });

  it('masks the annotated field for the identity listed in "users"', async () => {
    const { data } = await GET(URL, as('mcp-agent'));

    expect(data.price).to.equal('***MASKED***');
    expect(data.title).to.equal('Wuthering Heights');
  });

  it('returns the real value on that same endpoint for a human user', async () => {
    const { data } = await GET(URL, as('alice'));

    expect(data.price).to.not.equal('***MASKED***');
    expect(data.price).to.match(/^\d+\.\d+$/);
  });

  it('returns the real value for an unauthenticated request too', async () => {
    const { data } = await GET(URL);

    expect(data.price).to.not.equal('***MASKED***');
    expect(data.price).to.match(/^\d+\.\d+$/);
  });

  it('reports which fields each identity had masked, so the split is auditable', async () => {
    await GET(URL, as('mcp-agent'));
    const agentDecision = decisions.find((d) => d.entity === 'CatalogService.Books');
    expect(agentDecision.fieldsToMask).to.deep.equal(['price']);

    decisions.length = 0;
    await GET(URL, as('alice'));
    const humanDecision = decisions.find((d) => d.entity === 'CatalogService.Books');
    // Unlike "services" scoping, the interceptor *is* attached here: the human's request is
    // still evaluated and reported, it just comes back with nothing to mask.
    expect(humanDecision.fieldsToMask).to.deep.equal([]);
  });
});
