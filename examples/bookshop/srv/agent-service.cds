using { sap.capire.bookshop as my } from '../db/schema';

/**
 * The AI/MCP-facing service — the same entities CatalogService already serves to the human
 * UI, projected into a service of their own so cap-mcp-guard can be scoped to just this one
 * ("cap-mcp-guard".services in package.json). Requests arriving here get the @mcp.policy
 * treatment declared in db/schema.cds; CatalogService is left completely untouched, so the
 * UI keeps reading real values from the same tables.
 *
 * @readonly throughout, deliberately: an agent that can write back the masked value it just
 * read would overwrite the real one, and the guard does not validate inbound writes.
 */
service AgentService @(path: 'agent') {
  @readonly entity Books   as projection on my.Books;
  @readonly entity Authors as projection on my.Authors;
}
