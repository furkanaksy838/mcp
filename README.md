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
no information about the real value. It's what you get by default in package.json (a bare field
name, or a `{ "field" }` object with no `type`), but **in `.cds` you have to name it explicitly**:
unlike `@mcp.policy.mask`, a bare `@mcp.policy.pseudonymize` with no type carries no value for the
annotation reader to see, and is ignored.

The only built-in typed generator today is `"iban"`: it keeps the real country code and total length, and
computes a real ISO 7064 MOD 97-10 check digit pair, so the fake IBAN passes standard IBAN
checksum validation — it isn't a real account, but nothing downstream sees it as malformed.
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

**Requires a secret.** Set the `CAP_MCP_GUARD_PSEUDONYM_SECRET` environment variable (or
pass `pseudonymSecret` directly to `registerCapMcpGuard`) — every pseudonym is derived from
it via HMAC, so without it a fake value can't be reproduced or tied back to a real one.
**Never commit this value.** If any entity configures `pseudonymize` and no secret is set,
the server fails to start rather than silently producing unprotected data. Rotating the
secret invalidates every previously-issued pseudonym (the same real value will map to a new
fake one from then on) — this is expected, not a bug.

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

`"services"` and `"users"` compose — set both if you want a dedicated AI-facing service *and*
identity verification within it.

## What you get, per request

- **Masking** — in `enforce` mode, fields listed under `mask` are replaced with `'***MASKED***'`, and fields under `pseudonymize` with a deterministic fake value (see above), in the real response. In `observe` mode nothing is touched; the guard only computes what *would* happen. Also applied one level deep to any `$expand`ed association whose target entity has its own policy.
- **Tool/row enforcement** — in `enforce` mode, a request naming an operation outside `allowTools` is rejected with a 403 before it runs; a response exceeding `maxRows` is truncated to that limit. In `observe` mode both are only computed and reported, never applied.
- **Audit log** — every request produces a structured JSON line (Context + Decision), to stdout and/or a file you choose.
- **OpenTelemetry spans** — every request also becomes a real span via `@opentelemetry/api`. If your app already has an OTel SDK configured (any OTLP-compatible backend — Grafana, Jaeger, Datadog, SAP Cloud Logging), the guard's spans just show up there, correctly linked into the caller's trace via W3C Trace Context (`traceparent`/`tracestate`) when present — no extra mapping needed, because the context schema was built against OTel's GenAI semantic conventions (`gen_ai.*`) from the start.

All three run independently and can each be disabled per-call (`audit: false`, `otel: false`) if you're wiring `registerCapMcpGuard` yourself instead of relying on auto-discovery.

## Try it

A full working example lives in [`examples/bookshop`](examples/bookshop) — SAP's own CAP getting-started sample, with `cap-mcp-guard` wired in and a `"cap-mcp-guard"` package.json config masking real fields on `CatalogService.Books`.

```bash
cd examples/bookshop
npm install
npm test    # runs enforce/observe/audit/OTel integration tests against a real CAP service
npm start   # boots a real server at localhost:4004 — flip package.json's "cap-mcp-guard".mode to "enforce"
            # and hit /odata/v4/browse/Books to see masking happen live
```

## Coming soon (not in v1)

- Approval workflows (human-in-the-loop for sensitive operations)
- Rate limiting and a dashboard UI

## Development

```bash
npm test   # unit tests for lib/core, lib/policy, lib/audit, lib/otel, lib/adapters
```

## License

MIT
