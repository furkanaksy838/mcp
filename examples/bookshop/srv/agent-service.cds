using { sap.capire.bookshop as my } from '../db/schema';

/**
 * Approach 1 — a service of its own for the agent.
 *
 * The same entities CatalogService already serves to the human UI, projected into a
 * dedicated service so the agent gets its own endpoint (/odata/v4/agent/...). CatalogService
 * is untouched, so the UI keeps reading real values from the same tables.
 *
 * @readonly throughout, deliberately: an agent that can write back the masked value it just
 * read would overwrite the real one, and the guard does not validate inbound writes.
 *
 * See srv/agent-entity.cds for the alternative that adds no service at all.
 */
service AgentService @(path: 'agent') {
  @readonly entity Books   as projection on my.Books;
  @readonly entity Authors as projection on my.Authors;
}

// Annotated here rather than on my.Books / my.Authors in db/schema.cds: a db-level annotation
// would propagate to CatalogService's projections as well and mask the UI. Annotating the
// projection keeps the rule attached to exactly what the agent reads.
annotate AgentService.Books   with { price        @mcp.policy.mask };
annotate AgentService.Authors with { placeOfDeath @mcp.policy.mask };
