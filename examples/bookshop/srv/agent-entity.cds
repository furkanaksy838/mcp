using { sap.capire.bookshop as my } from '../db/schema';
using { CatalogService } from './cat-service';

/**
 * Approach 2 — no extra service: the agent gets its own *entity* inside the service the UI
 * already uses.
 *
 * Useful when adding a second CDS service isn't wanted (one more router, one more set of
 * projections to keep in sync) but identity-based scoping ("users") isn't either — that one
 * needs a real IdP and a technical-user id in config, and is only as strong as your auth.
 * Here the agent simply reads a different URL:
 *
 *   /odata/v4/browse/AgentBooks   → guarded, price masked
 *   /odata/v4/browse/Books        → the UI's own entity, untouched
 *
 * Both are views over the same table; nothing is copied. The guard keys its policy by entity
 * name (CatalogService.AgentBooks vs CatalogService.Books), so one carries a policy and the
 * other simply has no entry — which is why this needs no "services"/"users" config at all.
 */
extend service CatalogService with {
  @readonly entity AgentBooks as projection on my.Books;
}

annotate CatalogService.AgentBooks with { price @mcp.policy.mask };
