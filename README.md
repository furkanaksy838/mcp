# cap-mcp-guard

**A CAP (CDS) plugin** — auto-discovered via `cds-plugin.js` the moment it's a dependency of your project, zero manual wiring required.

CAP MCP Guard is the trust layer for AI agents accessing SAP CAP business data — request interception, policy enforcement, field masking, and OpenTelemetry-native observability for MCP-enabled applications.

Today, organizations have only two options when exposing SAP CAP business data to AI agents: grant unrestricted access or deny access completely. CAP MCP Guard introduces a third option — controlled, observable, and policy-driven access, without requiring developers to hand-write authorization, masking, and audit logic for every entity.

We give CAP developers a standardized, reusable way to enforce AI-agent security, observability, and policy — without hand-writing that logic for every entity. Convention over implementation, in the same spirit as CAP itself.

## Why

- **Field exposure.** When AI agents connect to CAP entities over MCP, sensitive fields (`CreditCardNo`, `Salary`, national ID numbers, ...) are visible to the agent unless someone filters them by hand, entity by entity.
- **No visibility.** Which agent accessed which entity, when, how many rows, and how long it took isn't logged anywhere standard. There's no answer when someone asks for an audit trail.
- **Excessive trust.** Even a "read-only" agent can technically reach every action/function a service exposes through the MCP layer, unless something enforces otherwise. Relying on the agent to "behave" isn't a control.
- **Enterprise distrust.** Companies want AI agents connected to business data, but security teams block it because nobody can prove what the agent will actually do. CAP MCP Guard is the third option between "wide open" and "no access at all."

## How it works

```text
AI Request → Intercept → Evaluate Policy → Mask → Execute → Audit → Trace
```

```text
Claude / Joule / Copilot / Custom Agent
              │
        Any MCP Runtime
   (gavdilabs/cap-mcp-plugin, a custom runtime, a future official SAP
    solution — it doesn't matter which)
              │
    ┌─────────────────────────┐
    │      cap-mcp-guard      │
    │                         │
    │  lib/core/              │
    │   ├─ interceptor.js     │ → attaches to CAP's srv.before/srv.after hooks
    │   └─ context.js         │ → builds an OTel gen_ai.*-shaped, framework-
    │                         │   agnostic request context
    │                         │
    │  lib/policy/            │ → knows nothing about CAP. Plain JS: Context in,
    │   ├─ config.js          │   Decision out.
    │   ├─ evaluator.js       │
    │   ├─ masking.js         │
    │   └─ pseudonym.js       │
    │                         │
    │  lib/audit/             │
    │   └─ log.js             │ → Context + Decision → structured JSON log line
    │                         │
    │  lib/otel/              │
    │   └─ exporter.js        │ → Context + Decision → a real OTel span
    │                         │
    │  lib/adapters/          │
    │   ├─ cap.js             │ → the ONE place that knows @sap/cds.
    │   │                     │   cds-plugin.js calls this.
    │   └─ annotations.js     │ → reads @mcp.policy off the compiled CDS model
    └─────────────────────────┘
              │
         CAP Service
```

`lib/policy/` and `lib/core/context.js` never import `@sap/cds` — they only ever see a plain `Context` object and a plain `PolicyDefinition` object, regardless of where either one came from. That's what lets policy come from package.json *and* from `@mcp.policy` CDS annotations (see [Configure](#configure)) without the engine knowing the difference, and what lets a third source be added later without touching it either.

## Install

```bash
npm install --save cap-mcp-guard
```

This is a **CDS plugin**, not a library you wire up by hand: CAP auto-discovers `cds-plugin.js` the moment the package is a dependency of your project — no manual `require`, no server bootstrap changes. Annotate your model, add a `"cap-mcp-guard"` key to your project's `package.json`, and both are picked up the next time your CAP server starts.

## Configure

There are two layers, and the split between them is fixed:

| Setting | `.cds` model (`@mcp.policy`) | `package.json` |
| --- | :---: | :---: |
| per-entity `mask`, `pseudonymize` — **which fields are sensitive** | yes | yes |
| per-entity `maxRows`, `allowTools` — per-entity limits | yes | yes |
| `mode`, `services`, `users`, `audit` — how the guard behaves overall | — | **only here** |

**Classify data in the model; switch the guard on in package.json.** A field is sensitive
because of what it *is*, not because of which environment you're in — so that belongs in the
`.cds` file, on the field itself. Whether the guard enforces or only observes, which services
and users it applies to, where the audit log goes: that's deployment configuration, and it
lives in package.json.

### Declaring policy in the schema

Annotate the fields directly, where nobody can add a new sensitive column without seeing the
rule sitting next to its neighbours:

```cds
entity Employees {
  key ID     : Integer;
      name   : String;
      salary : Decimal(10, 2) @mcp.policy.mask;
      iban   : String         @mcp.policy.pseudonymize: 'iban';
}

@mcp.policy.maxRows: 100
entity Orders as projection on my.Orders;
```

- `@mcp.policy.mask` on a field — replaced with `'***MASKED***'` in agent-facing responses.
- `@mcp.policy.pseudonymize: 'iban'` — replaced with a fake but deterministic value; the string names the generator (`'opaque'` or `'iban'`, see [Masking vs. pseudonymizing](#masking-vs-pseudonymizing)) and is **required here**. Use an object for `custom`: `@mcp.policy.pseudonymize: {type: 'custom', value: 'hidden@example.com'}`.
- `@mcp.policy.maxRows` / `@mcp.policy.allowTools` — entity-level.

Annotations are read off the compiled model once services are served, so **entity names always
match** — there's no name to keep in sync by hand, which is the main practical advantage over
configuring the same fields in package.json (see the naming caveat below).

**They propagate the way CDS annotations always do.** Annotate a field on a `db/` entity and
every service projecting that entity inherits the rule — including your human-facing UI service,
which will then see masked data too. That's what `"services"`/`"users"` scoping is for: classify
once in the model, then scope *where* the guard applies. (Annotating only the AI-facing
projection entity works too, at the cost of moving the rule away from the field again.)

### Switching the guard on in package.json

Annotations classify; they can't turn enforcement on by themselves. The `"cap-mcp-guard"` key is
what activates the guard and scopes it:

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "services": ["AgentCatalogService"]
  }
}
```

- No `"cap-mcp-guard"` key at all? The guard runs in pass-through mode (a `console.warn` tells you so) rather than crashing your server — no matter how much you annotated.
- A config that exists but fails to parse *does* fail loudly — a broken config shouldn't fail silently.
- `mode` is `"observe"` (compute and log what *would* happen, touch nothing) or `"enforce"` (actually mask, truncate, and reject). Start with `observe`, read the audit log, then flip.

You can also declare per-entity rules here instead of — or on top of — the annotations, which is
the right call when a limit is environment-specific (`maxRows` of 500 in dev, 50 in prod) rather
than a property of the data:

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "entities": {
      "AgentCatalogService.Orders": {
        "mask": ["creditCard", "salary"],
        "maxRows": 100,
        "allowTools": ["ReadOrders"]
      },
      "AgentCatalogService.Customers": {
        "mask": ["email", "phone"]
      }
    }
  }
}
```

- **Entity keys are service-qualified.** They're matched *exactly* against the name the request resolves to — `AgentCatalogService.Orders`, not the bare `Orders`. A key matching no served entity is inert rather than an error (that entity simply has no policy), so a typo or a renamed service silently means *no enforcement*. This is the trap annotations avoid.
- Entities configured in neither layer are fully accessible — this is opt-in by design; you don't have to cover every entity up front.

### How the two layers merge

Annotation-derived and package.json-derived config for the same entity are merged, per entity:

- `mask` — union of both sides' fields.
- `pseudonymize` — union by field; the package.json entry wins if the same field is configured on both sides.
- `maxRows` / `allowTools` — the package.json value wins when both are present.
- A field listed under `mask` from one source and `pseudonymize` from the other fails loudly at startup, exactly like configuring both in the same package.json entity.

### What a masked value looks like, per field type

A property has exactly one type — the one the service publishes in `$metadata` — so the
replacement has to fit it. `'***MASKED***'` is a string, and writing it into an `Edm.Decimal` or
`Edm.Date` property produces a response that contradicts its own metadata: Fiori Elements renders
an empty cell (which reads as *no value*, not *withheld*), and a generated client fails to parse.

So the replacement is chosen from the field's compiled type:

| Field type | Masked to |
| --- | --- |
| `String`, `LargeString` | `'***MASKED***'` |
| everything else — numbers, dates, booleans, `UUID`, … | `null` |

Both are type-valid, and either way the record of *which* fields were withheld travels in the
Decision, so it reaches the audit log and the OTel span even when the payload just shows `null`.
(`UUID` is in the second group on purpose: it's a string in JS but surfaces as `Edm.Guid`, and the
placeholder isn't a GUID.)

There are two ways to get the placeholder *visible* on a non-string field, and which one fits
depends on whether the agent has a projection of its own.

**It does** — model the field as text there, and it genuinely becomes a string field:

```cds
@readonly entity AgentEmployees as projection on my.Employees {
  ID, name, role,
  cast(salary as String(20)) as salary,   // now masked to '***MASKED***'
  iban
};
```

The UI's own projection keeps `salary` as `Decimal` and keeps reading real numbers — one field,
one type, per projection, and no metadata is contradicted.

**It doesn't** — one entity serves both audiences and identity decides who sees what (`"users"`
scoping). Then there is no second projection to cast in, and the type-safe default is working
against you: Fiori always receives real Decimals here, so the masked copy only ever reaches
something reading JSON. Turn it off (see
[below](#getting-the-placeholder-onto-a-non-string-field)):

```json
{ "cap-mcp-guard": { "mode": "enforce", "users": ["mcp-agent"], "maskTypeSafe": false } }
```

### Masking vs. pseudonymizing

Plain `mask` replaces every real value with the same fixed string, `'***MASKED***'` —
which means an AI agent can no longer tell two different customers' masked fields apart at
all (no grouping, no counting distinct values, no relational reasoning). `pseudonymize`
replaces a real value with a **fake but deterministic** one instead: the same real value
always produces the same fake value, and different real values produce different fake
values — so the agent keeps that relational structure without ever seeing the real data.

```cds
entity Customers {
  key ID         : Integer;
      creditCard : String @mcp.policy.mask;                    // → '***MASKED***'
      email      : String @mcp.policy.pseudonymize: 'opaque';  // → 'email-7f3a9c21e1b4'
      iban       : String @mcp.policy.pseudonymize: 'iban';    // → a checksum-valid fake IBAN
}
```

The same, in package.json:

```json
{
  "cap-mcp-guard": {
    "entities": {
      "AgentCatalogService.Customers": {
        "mask": ["creditCard"],
        "pseudonymize": ["email", { "field": "iban", "type": "iban" }]
      }
    }
  }
}
```

`"opaque"` is the generic generator — a deterministic token like `email-7f3a9c21e1b4`, carrying
no information about the real value. It's the default everywhere a type isn't named: a bare
field name or a `{ "field" }` object in package.json, and a bare `@mcp.policy.pseudonymize`
(no type) in `.cds`.

Two typed generators exist alongside it, both format-preserving so the fake value passes wherever
the real one would:

- `"iban"` keeps the real country code and total length and computes a real ISO 7064 MOD 97-10
  check digit pair, so the fake IBAN passes standard IBAN checksum validation. Not a real account,
  but nothing downstream sees it as malformed.
- `"uuid"` produces a syntactically valid v4 UUID, for fields declared `UUID` (see
  [below](#linking-records-use-a-canonical-id-not-a-name)).

A field can't be listed in both `mask` and `pseudonymize` on the same entity (config fails
to load if it is). More typed generators (e.g. a Luhn-valid fake credit card number) can be
added later without changing this config shape — anything without a dedicated generator
just falls back to `"opaque"`.

Sometimes you don't want a *derived* fake value at all — just one fixed, human-chosen
replacement, the same for every row (e.g. a shared support alias instead of each customer's
real email). Use `type: "custom"` with a required `"value"`:

```cds
entity Customers {
  key ID    : Integer;
      email : String @mcp.policy.pseudonymize: {type: 'custom', value: 'hidden@example.com'};
}
```

```json
{
  "cap-mcp-guard": {
    "entities": {
      "AgentCatalogService.Customers": {
        "pseudonymize": [{ "field": "email", "type": "custom", "value": "hidden@example.com" }]
      }
    }
  }
}
```

Unlike `"opaque"`/`"iban"`, `"custom"` doesn't derive anything from the real value or the
pseudonym secret — every row gets the exact same literal, so it doesn't need
`CAP_MCP_GUARD_PSEUDONYM_SECRET` at all (a config that mixes a `"custom"` entry with a
non-`"custom"` one on the same or another entity still needs the secret, for the other
entry). Because every real value maps to the same output, `"custom"` gives up the
relational structure (telling two customers apart) that `"opaque"`/`"iban"` preserve — it's
closer in effect to `mask`, just with your own replacement string instead of the fixed
`'***MASKED***'`.

#### Keeping one value recognizable across differently-named fields

`"opaque"` derives its token from the **field name plus the value**, so the same real value
under two differently-named fields comes out as two different pseudonyms. That's the right
default — unrelated fields shouldn't become correlatable just because they happen to hold
equal values. But it's wrong for the case where one logical value is simply *spelled*
differently across a large model: `syd` in one entity, `soyad` in another, `lastName` in a
third. The agent sees three unrelated tokens and can no longer tell it's one person.

`"group"` names an explicit pseudonym namespace, replacing the field name in the derivation.
Fields sharing a group produce identical pseudonyms for identical values, however they're
named:

```cds
type Soyad : String(100) @mcp.policy.pseudonymize: { type: 'opaque', group: 'surname' };

entity Employees { syd      : Soyad; }
entity Customers { soyad    : Soyad; }
entity Vendors   { lastName : Soyad; }
```

Annotating the **type** rather than each element is what makes this scale: every field of that
type inherits the policy no matter what it's called, and a field added later can't be
forgotten. CDS propagates element annotations from a named type to every element using it,
and on into service projections.

The same in package.json:

```json
{
  "cap-mcp-guard": {
    "entities": {
      "AgentService.Employees": { "pseudonymize": [{ "field": "syd", "group": "surname" }] },
      "AgentService.Customers": { "pseudonymize": [{ "field": "soyad", "group": "surname" }] }
    }
  }
}
```

The group name replaces the field name in the token too (`surname-7f3a9c21e1b4`), so the
output doesn't disclose which field it came from. Different groups still separate equal values,
and rotating `CAP_MCP_GUARD_PSEUDONYM_SECRET` still invalidates everything as before. `"iban"`
is already field-name-independent by construction, so a group is optional there and only
affects its fallback for malformed values; `"custom"` derives nothing at all, so combining it
with `"group"` is rejected at config load rather than silently ignored.

#### Linking records: use a canonical id, not a name

A shared surname is not a shared person — two people can both be `Yilmaz`. If the agent needs to
follow one person across entities, pseudonymize the id everyone already joins on, not the name:

```cds
type ProtectedPersonId : UUID @mcp.policy.pseudonymize: { type: 'uuid', group: 'person-id' };

entity Employees { personId   : ProtectedPersonId; }
entity Managers  { employeeId : ProtectedPersonId; }
```

Note `type: 'uuid'` rather than `opaque`. `opaque` produces a token like
`person-id-0787abd9060d`, and a field declared `UUID` surfaces as `Edm.Guid` — handing that token
back makes the response contradict its own metadata and anything that parses GUIDs rejects it.
`uuid` produces a deterministic, syntactically valid v4 UUID instead, the same way `iban` produces
a checksum-valid IBAN: `0787abd9-060d-4204-b5e9-2a34a462023d`, identical for the same real id and
group, different for a different one, and not the real value.

#### Keeping groups honest: an allowlist and a startup lint

A group is a namespace shared by name, so a typo in one is silent and expensive: `person-surename`
in one entity and `person-surname` in another produce two namespaces that will never match, and
nothing at runtime says so. Declare the groups you actually use and a stray one becomes a startup
error:

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "pseudonymGroups": ["person-id", "person-surname", "iban"],
    "lint": { "strict": true }
  }
}
```

```text
entities.Customers.pseudonymize.surname: group "person-surename" is not in "pseudonymGroups"
("person-id", "person-surname", "iban")
```

`pseudonymGroups` is optional — omit it and groups stay free-form, which is fine for a small
model. Once declared it is enforced, since that is what an allowlist is for.

`lint` prints what the policy will actually do, once, at startup, and checks the parts a machine
can decide:

```text
[cap-mcp-guard] pseudonym groups:
[cap-mcp-guard]   person-id
[cap-mcp-guard]     - CatalogService.AgentEmployees.personId
[cap-mcp-guard]     - CatalogService.AgentManagers.employeeId
[cap-mcp-guard]   person-surname
[cap-mcp-guard]     - CatalogService.AgentEmployees.syd
[cap-mcp-guard] warning: CatalogService.AgentEmployees.salary: masking a cds.Decimal field yields
[cap-mcp-guard]          null rather than '***MASKED***', since the placeholder is a string.
```

The group map is the point: a mistyped or duplicated group shows up as a group of one. Errors are
generator/field-type mismatches — a `uuid` pseudonym on a string field, a string pseudonym on a
UUID or numeric field — the class of defect that looks fine in the guard's own audit log and only
surfaces at whatever consumes the payload. `lint: true` reports; `lint: { strict: true }` refuses
to start:

```text
Error: [cap-mcp-guard] policy lint failed with 1 error(s) and lint.strict is set:
  - CatalogService.ProbeView.pid: pseudonymize type "opaque" produces a string, but the field is
    cds.UUID. Use type "uuid" for a UUID field.
```

What it deliberately does *not* check is whether a field is bound to the *right* group — a linter
can't know that `Customers.surname` and `Employees.syd` are the same concept, only that they claim
to be. That part is what the group map is for reading.

#### Getting the placeholder onto a non-string field

The type-safe default assumes the masked payload reaches a typed consumer. That is true when the
UI and the agent read the same entity through different projections — but not when they read the
*same* entity and only the agent's copy is masked, as with `"users"` scoping. There Fiori always
receives real Decimals, the masked copy only ever reaches something reading JSON, and a `null` it
can't distinguish from an empty column is strictly less informative than a placeholder.

`"maskTypeSafe": false` says so:

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "users": ["mcp-agent"],
    "maskTypeSafe": false,
    "maskValue": "***MASKED***"
  }
}
```

```json
{ "ID": 1, "name": "***MASKED***", "salary": "***MASKED***", "hiredOn": "***MASKED***" }
```

`maskValue` sets the text (default `'***MASKED***'`) and applies either way. With `maskTypeSafe`
off, a non-string field's response contradicts its own `$metadata` — which is exactly the trade
being made, so the startup lint says which of the two is in force rather than staying silent:

```text
[cap-mcp-guard] warning: CatalogService.Employees.salary: "maskTypeSafe" is off, so this
                         cds.Decimal field is masked to the string "***MASKED***" and the response
                         contradicts its own $metadata. Fine for a JSON-reading agent, not for a
                         typed client such as Fiori.
```

Use it when one entity serves both audiences and identity decides who sees what. When the agent
has a projection of its own, `cast(salary as String(20)) as salary` gets you the same placeholder
with no metadata contradiction, because there the field genuinely *is* text.

**Requires a secret.** Set the `CAP_MCP_GUARD_PSEUDONYM_SECRET` environment variable (or
pass `pseudonymSecret` directly to `registerCapMcpGuard`) — every pseudonym is derived from
it via HMAC, so without it a fake value can't be reproduced or tied back to a real one.
**Never commit this value.** If any entity configures `pseudonymize` and no secret is set,
the server fails to start rather than silently producing unprotected data. Rotating the
secret invalidates every previously-issued pseudonym (the same real value will map to a new
fake one from then on) — this is expected, not a bug.

### Separating the agent from the UI: three shapes

When the same tables serve both a human UI and an agent, masking everything is wrong — the UI
would see placeholders too. Something has to tell the two apart, and there are exactly three
things that can: **which service** the request arrived at, **which entity** it named, or **who**
sent it. Each is a subsection below; this is how to pick.

| | Own service | Own entity | Identity |
| --- | --- | --- | --- |
| Config | `"services": [...]` | none | `"users": [...]` |
| Extra CDS objects | one service | one entity per guarded table | none |
| Needs a trustworthy IdP | no | no | **yes** |
| Placeholder on a numeric field | via `cast` | via `cast` | via `"maskTypeSafe": false` |
| UI requests reach the guard | no | yes, and pass through | yes, and pass through |
| UI requests in the audit log | no | yes | yes |
| Agent can reach the unmasked copy | only by calling a URL it wasn't given | same | **by presenting another identity** |

Pick **identity** only when you cannot add a projection — you don't own the model, or the agent is
contractually bound to an existing entity. It is the smallest change and the weakest boundary: with
CAP's `mocked` auth an agent simply sends another user's name, so it is worth having only behind
XSUAA, IAS, Entra, Okta or a gateway that terminates authentication.

Otherwise put the boundary in the URL, where there is nothing to impersonate. Choose **own entity**
by default and **own service** when UI traffic is heavy enough that you don't want it passing
through the guard at all (it is the only shape where the interceptor never attaches to the UI's
service, so those requests cost nothing and produce no audit lines).

Whichever you pick, the field-level decisions are the same and are worth making in this order:

1. **Leave it out** of what the agent reads, if it has no business with it. An absent field can't be
   selected, filtered, sorted, aggregated or navigated to — strictly stronger than any policy here.
2. **`mask`** it if the agent should know the field exists but never its value.
3. **`pseudonymize`** it if the agent has to reason across rows — count distinct values, spot
   duplicates, follow one person through the model — without seeing the real thing.

### Scoping by entity, without a second service

Give the agent its own *entity* inside the service the UI already uses. The guard keys its policy by
entity name, so one carries a policy and the other simply has no entry — which is why this shape
needs no `"services"` and no `"users"` at all:

```cds
service CatalogService {
  // With two projections of one db entity in a service, CDS can't guess which an association
  // should point at. Naming the UI's keeps navigation resolving to the unmasked pair.
  @cds.redirection.target
  entity Employees as projection on my.Employees;

  @readonly entity AgentEmployees as projection on my.Employees {
    ID, name, role,
    cast(salary as String(20)) as salary,
    iban
  };
}

annotate CatalogService.AgentEmployees with {
  salary @mcp.policy.mask;
  iban   @mcp.policy.pseudonymize: 'iban';
};
```

```json
{ "cap-mcp-guard": { "mode": "enforce" } }
```

Three things make this shape hold, and skipping any of them quietly undoes it:

- **Annotate the agent's projection, never the db entity.** A `@mcp.policy` annotation on
  `my.Employees` propagates to *every* projection of it, the UI's included.
- **List fields instead of `*`.** Under a wildcard, a sensitive column added to `my.Employees`
  tomorrow appears in the agent's view immediately and unmasked, since the policy names fields and a
  new one isn't among them. Listing makes the agent's surface an allowlist.
- **Leave the associations out.** Included, they redirect to the entity marked
  `@cds.redirection.target` — the unmasked one — and `AgentEmployees?$expand=department` hands over
  real values straight past the policy.

[`examples/bookshop`](examples/bookshop) ships this shape and the next one side by side, both
covered by integration tests.

### Scoping the guard to specific services

If the same entities are served both to a human-facing UI and to an AI/MCP agent, masking
everything is usually wrong — the UI would see masked fields too. Add a `"services"` array
to scope the guard to only the CAP services named there; every other served service is left
completely untouched (no masking, no audit, no interceptor at all):

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "services": ["AgentCatalogService"],
    "entities": {
      "AgentCatalogService.Customers": { "mask": ["IBAN"] }
    }
  }
}
```

The recommended pattern: expose the AI/MCP-facing traffic through its own CDS service (a
projection over the same entities your UI's service already serves), point `"services"` at
that one, and leave your UI's service out of the list entirely — it keeps seeing real,
unmasked data. Omitting `"services"` keeps the default: every served service is guarded, as
before.

### Scoping the guard to specific users

If splitting into a second CDS service isn't worth it, scope the guard by **identity**
instead, using CAP's own authenticated user (`req.user.id`, not a client-supplied header —
so it can't be spoofed the way a raw HTTP header could). Add a `"users"` array: masking (and
`allowTools`/`maxRows` enforcement) only applies to requests whose authenticated user is in
that list — everyone else's request is fully passed through, exactly as if the entity had no
policy at all:

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "users": ["mcp-agent-technical-user"],
    "entities": {
      "AgentCatalogService.Customers": { "mask": ["IBAN"] }
    }
  }
}
```

Authenticate your MCP runtime as that technical user (via XSUAA/IAS, a service key bound to
the CAP app) so its requests carry that identity; your UI's human users authenticate
normally and are never in the list, so they always see real data through the same service and
the same endpoint. This is only as secure as your CAP app's auth strategy — it requires a
real, verified identity provider (XSUAA/IAS/JWT) in production. `mocked` auth (fine for local
dev, as `examples/bookshop` uses) lets `req.user.id` be set by an untrusted client-supplied
header, which defeats this entirely.

Because both audiences read the same entity here, a field has one type for both of them and there
is no agent-side projection to `cast` in. That is what `"maskTypeSafe": false` is for — see
[Getting the placeholder onto a non-string field](#getting-the-placeholder-onto-a-non-string-field).
It is safe in exactly this shape: Fiori never receives a masked payload, so the only consumer of the
placeholder is something reading JSON.

`"services"` and `"users"` compose — set both if you want a dedicated AI-facing service *and*
identity verification within it.

## What you get, per request

- **Masking** — in `enforce` mode, fields listed under `mask` are replaced with `'***MASKED***'` on string fields and `null` on every other type (see [above](#what-a-masked-value-looks-like-per-field-type)), and fields under `pseudonymize` with a deterministic fake value, in the real response. In `observe` mode nothing is touched; the guard only computes what *would* happen. Applied at **every** level of `$expand`, not just the first: each nested entity is evaluated on its own, so identity scoping applies there too and an association path back to an already-masked entity doesn't hand over raw values on the second hop.
- **Query-side refusal** — masking rewrites the response, but `$filter`, `$orderby`, `$groupby` and aggregations run against the *real* column, so the result set itself discloses what the payload hides: which rows come back, in what order, what they sum to — and repeated range filters recover an exact value by bisection. In `enforce` mode a request that computes over a masked or pseudonymized field is rejected with 403 before it runs. Plainly *selecting* such a field stays allowed, since that is what masking is for. In `observe` mode the refusal is reported, not applied.
- **Write refusal** — a caller that only ever reads a field masked must not be able to write it, or it replaces the real value with the placeholder (or with a pseudonym plausible enough that nobody notices). In `enforce` mode a `CREATE`/`UPDATE`/`UPSERT` whose payload carries a protected field is rejected with 403. `@readonly` on the agent-facing projection is still the better first line; this is what catches the case where it was forgotten.
- **Tool/row enforcement** — in `enforce` mode, a request naming an operation outside `allowTools` is rejected with a 403 before it runs. `maxRows` is pushed onto the query as a `LIMIT` before it executes — so the database stops reading rows that were always going to be discarded — and the response is truncated to the same bound. A client asking for fewer rows keeps its own smaller limit. In `observe` mode both are only computed and reported, never applied.
- **Audit log** — every request produces a structured JSON line (Context + Decision), to stdout and/or a file you choose.
- **OpenTelemetry spans** — every request also becomes a real span via `@opentelemetry/api`. If your app already has an OTel SDK configured (any OTLP-compatible backend — Grafana, Jaeger, Datadog, SAP Cloud Logging), the guard's spans just show up there, correctly linked into the caller's trace via W3C Trace Context (`traceparent`/`tracestate`) when present — no extra mapping needed, because the context schema was built against OTel's GenAI semantic conventions (`gen_ai.*`) from the start.

Audit and OTel run independently of each other and can each be disabled per-call (`audit: false`,
`otel: false`) if you're wiring `registerCapMcpGuard` yourself instead of relying on
auto-discovery.

## Known limits

The guard rewrites responses and refuses requests. It is not an authorization layer, and a few
things follow from that — worth knowing before you rely on it.

**The un-guarded path stays open.** Scoping with `"services"` doesn't stop an agent from calling a
service that isn't in the list; it stops the guard from touching that service. Same for an
agent-facing entity: `AgentEmployees` being masked says nothing about `Employees` next to it. Close
the human-facing surface with CAP's own `@requires` / `@restrict`, or don't tell the agent about it
(an entity that isn't in the MCP runtime's tool list is one it can't call).

**Refusal is not the same as concealment.** A 403 on `$filter=salary gt 100000` tells the caller
that `salary` is protected — and `$metadata` lists the field either way. If a field's *existence*
is sensitive, leave it out of the agent's projection (`excluding { salary }`) rather than mask it.
An absent field can't be selected, filtered, sorted, aggregated or navigated to, which makes
`excluding` strictly stronger than any policy here. Mask what the agent must know about but
shouldn't read; exclude everything else.

**Nested query options aren't checked.** A `$filter` *inside* an `$expand` belongs to the nested
entity and isn't matched against that entity's policy, only the top level's. The nested rows still
come back masked; what leaks is which of them come back. `@Capabilities.ExpandRestrictions` or
cutting the association on the agent's projection closes it.

**Masked columns are still read.** The refusal above stops the query from *computing* over a
protected field, but a plain `$select` of it still fetches the real value from the database before
the response is rewritten. That's a cost, not a disclosure — the value never leaves the process —
but on a wide table it is a real one.

**Row count is bounded, not the work.** `maxRows` caps rows. It doesn't cap columns, joins, or the
cost of a `$filter` over an unprotected but unindexed field.

**Uniqueness leaks through pseudonyms, by design.** Two rows sharing a real value share a
pseudonym; that is the whole point, and it means an agent can count distinct values and spot
duplicates. If even that is too much, use `mask` — and if the *shape* matters (a valid IBAN tells
you the country), use `type: "custom"` or exclude the field.

**Prefer endpoint scoping over identity scoping.** `"users"` is only as trustworthy as the app's
authentication: with CAP's `mocked` auth an agent can simply present another user's name. Splitting
the agent's surface into its own service or its own entity puts the boundary in the URL, where
there is nothing to impersonate.

## Try it

A full working example lives in [`examples/bookshop`](examples/bookshop) — SAP's own CAP getting-started sample, with both agent-facing shapes wired up and package.json containing nothing but `{"mode": "enforce"}`:

- **A service of its own** — [`srv/agent-service.cds`](examples/bookshop/srv/agent-service.cds) adds `AgentService` at `/odata/v4/agent`, projecting the same entities `CatalogService` serves to the UI.
- **An entity of its own, in the UI's service** — [`srv/agent-entity.cds`](examples/bookshop/srv/agent-entity.cds) adds `CatalogService.AgentBooks` at `/odata/v4/browse/AgentBooks`, no second service involved.

Both annotate the *agent-facing projection*, never the db entity — that's what leaves the UI's own entities policy-free, and why neither needs `"services"` or `"users"` scoping.

```bash
cd examples/bookshop
npm install
npm test    # annotation/enforce/observe/identity/audit/OTel integration tests against a real CAP service
npm start   # boots a real server at localhost:4004
```

With the server up, read the same row three ways:

```bash
curl 'http://localhost:4004/odata/v4/agent/Books(201)?$select=price'        # "***MASKED***"  (own service)
curl 'http://localhost:4004/odata/v4/browse/AgentBooks(201)?$select=price'  # "***MASKED***"  (own entity)
curl 'http://localhost:4004/odata/v4/browse/Books(201)?$select=price'       # "11.11"         (the UI's entity)
```

One table, one row, no copies — masked for the agent, untouched for the UI. Point your MCP runtime at either agent URL; the UI keeps using `/odata/v4/browse/Books` unchanged.

## Coming soon (not in v1)

- Approval workflows (human-in-the-loop for sensitive operations)
- Rate limiting and a dashboard UI

## Development

```bash
npm test   # unit tests for lib/core, lib/policy, lib/audit, lib/otel, lib/adapters
```

## License

MIT
