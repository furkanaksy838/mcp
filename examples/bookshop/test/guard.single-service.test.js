'use strict';

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

// The single-service alternative to guard.annotations.test.js: no second CDS service and no
// "services" scoping at all. The agent and the human hit the very same endpoint, and the only
// thing separating them is CAP's own authenticated req.user.id, listed under "users".
//
// `entities` is deliberately empty — Books.price's mask comes from the @mcp.policy.mask
// annotation in db/schema.cds, merged into this policy at boot. So this suite also proves the
// schema-declared policy works identically whichever way the guard is scoped.
describe('cap-mcp-guard — one service, agent and human separated by identity', () => {
  const decisions = [];

  registerCapMcpGuard(cds, {
    policyDefinition: { mode: 'enforce', users: ['mcp-agent'], entities: {} },
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
