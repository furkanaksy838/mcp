using { Currency, cuid, managed, sap } from '@sap/cds/common';
namespace sap.capire.bookshop;

// The @mcp.policy annotations below are cap-mcp-guard's policy, declared on the fields
// themselves rather than in package.json — so a new sensitive column can't be added without
// its rule sitting right next to it. They propagate to every service projecting these
// entities; which of those services the guard actually enforces on is scoped separately,
// via "cap-mcp-guard".services in package.json (here: AgentService only, so the UI's
// CatalogService keeps seeing real values).

entity Books : managed {
  key ID   : Integer;
  author   : Association to Authors @mandatory;
  title    : localized String @mandatory;
  descr    : localized String(2000);
  genre    : Association to Genres;
  stock    : Integer;
  price    : Price @mcp.policy.mask;
  currency : Currency;
}

entity Authors : managed {
  key ID       : Integer;
  name         : String @mandatory;
  dateOfBirth  : Date;
  dateOfDeath  : Date;
  placeOfBirth : String;
  placeOfDeath : String @mcp.policy.mask;
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
