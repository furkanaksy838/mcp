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

```
AI Request → Intercept → Evaluate Policy → Mask → Execute → Audit → Trace
```

```
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
    │   └─ cap.js             │ → the ONE place that knows @sap/cds.
    │                         │   cds-plugin.js calls this.
    └─────────────────────────┘
              │
         CAP Service
```

`lib/policy/` and `lib/core/context.js` never import `@sap/cds` — they only ever see a plain `Context` object and a plain `PolicyDefinition` object, regardless of where either one came from. That's what lets the `"cap-mcp-guard"` package.json config be swapped out for a future CDS-annotation-based source later without touching the engine itself.

## Install

```bash
npm install --save cap-mcp-guard
```

This is a **CDS plugin**, not a library you wire up by hand: CAP auto-discovers `cds-plugin.js` the moment the package is a dependency of your project — no manual `require`, no server bootstrap changes. Add a `"cap-mcp-guard"` key to your project's `package.json` and it's picked up automatically the next time your CAP server starts.

## Configure

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "entities": {
      "Orders": {
        "mask": ["CreditCard", "Salary"],
        "maxRows": 100,
        "allowTools": ["ReadOrders"]
      },
      "Customers": {
        "mask": ["Email", "Phone"]
      }
    }
  }
}
```

- Entities not listed here are fully accessible — this is opt-in by design; you don't have to configure every entity up front.
- No `"cap-mcp-guard"` key at all? The guard runs in pass-through mode (a `console.warn` tells you so) rather than crashing your server.
- A config that exists but fails to parse *does* fail loudly — a broken config shouldn't fail silently.

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
      "Customers": { "mask": ["IBAN"] }
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
      "Customers": { "mask": ["IBAN"] }
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

### Pseudonymizing instead of redacting

Plain `mask` replaces every real value with the same fixed string, `'***MASKED***'` —
which means an AI agent can no longer tell two different customers' masked fields apart at
all (no grouping, no counting distinct values, no relational reasoning). `pseudonymize`
replaces a real value with a **fake but deterministic** one instead: the same real value
always produces the same fake value, and different real values produce different fake
values — so the agent keeps that relational structure without ever seeing the real data.

```json
{
  "cap-mcp-guard": {
    "mode": "enforce",
    "entities": {
      "Customers": {
        "mask": ["CreditCard"],
        "pseudonymize": [
          "Email",
          { "field": "IBAN", "type": "iban" }
        ]
      }
    }
  }
}
```

Each entry is either a bare field name (uses the generic `"opaque"` generator — a
deterministic token like `Email-7f3a9c21e1b4`, carrying no information about the real
value) or a `{ "field", "type" }` object naming a specific generator. The only built-in
typed generator today is `"iban"`: it keeps the real country code and total length, and
computes a real ISO 7064 MOD 97-10 check digit pair, so the fake IBAN passes standard IBAN
checksum validation — it isn't a real account, but nothing downstream sees it as malformed.
A field can't be listed in both `mask` and `pseudonymize` on the same entity (config fails
to load if it is). More typed generators (e.g. a Luhn-valid fake credit card number) can be
added later without changing this config shape — anything without a dedicated generator
just falls back to `"opaque"`.

**Requires a secret.** Set the `CAP_MCP_GUARD_PSEUDONYM_SECRET` environment variable (or
pass `pseudonymSecret` directly to `registerCapMcpGuard`) — every pseudonym is derived from
it via HMAC, so without it a fake value can't be reproduced or tied back to a real one.
**Never commit this value.** If any entity configures `pseudonymize` and no secret is set,
the server fails to start rather than silently producing unprotected data. Rotating the
secret invalidates every previously-issued pseudonym (the same real value will map to a new
fake one from then on) — this is expected, not a bug.

## What you get, per request

- **Masking** — in `enforce` mode, fields listed under `mask` are replaced with `'***MASKED***'`, and fields under `pseudonymize` with a deterministic fake value (see above), in the real response. In `observe` mode nothing is touched; the guard only computes what *would* happen.
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

- `@mcp.policy`-style CDS annotations as an alternative to the `"cap-mcp-guard"` package.json config
- Approval workflows (human-in-the-loop for sensitive operations)
- Rate limiting and a dashboard UI
- Actually blocking a request when `allowTools`/`maxRows` is violated (today those are computed and reported, not enforced)

## Development

```bash
npm test   # unit tests for lib/core, lib/policy, lib/audit, lib/otel, lib/adapters
```

## License

MIT