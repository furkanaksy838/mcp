using { Currency, cuid, managed, sap } from '@sap/cds/common';
namespace sap.capire.bookshop;

// cap-mcp-guard's policy for these entities lives in @mcp.policy annotations, but NOT here:
// see srv/agent-service.cds and srv/agent-entity.cds, which annotate the agent-facing
// projections instead. Annotating a db entity would propagate the rule to every service
// projecting it — including the human-facing CatalogService, which would then see masked
// values too. Annotating only what the agent reads keeps the UI untouched without needing
// any scoping config ("services"/"users") in package.json at all.

entity Books : managed {
  key ID   : Integer;
  author   : Association to Authors @mandatory;
  title    : localized String @mandatory;
  descr    : localized String(2000);
  genre    : Association to Genres;
  stock    : Integer;
  price    : Price;
  currency : Currency;
}

entity Authors : managed {
  key ID       : Integer;
  name         : String @mandatory;
  dateOfBirth  : Date;
  dateOfDeath  : Date;
  placeOfBirth : String;
  placeOfDeath : String;
  books        : Association to many Books on books.author = $self;
}

/** Hierarchically organized Code List for Genres */
entity Genres : cuid, sap.common.CodeList {
  parent   : Association to Genres;
  children : Composition of many Genres on children.parent = $self;
}

type Price : Decimal(9,2);


// --------------------------------------------------------------------------------
// Temporary workaround for this situation:
// - Fiori apps in bookstore annotate Books with @fiori.draft.enabled.
// - Because of that .csv data has to eagerly fill in ID_texts column.
annotate Books with @fiori.draft.enabled;
