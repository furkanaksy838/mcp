# cap-mcp-guard

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
    │   └─ masking.js         │
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

`lib/policy/` and `lib/core/context.js` never import `@sap/cds` — they only ever see a plain `Context` object and a plain `PolicyDefinition` object, regardless of where either one came from. That's what lets `cap-mcp-guard.yaml` be swapped out for a future CDS-annotation-based source later without touching the engine itself.

## Install

```bash
npm install --save-dev cap-mcp-guard
```

CAP auto-discovers `cds-plugin.js` the moment the package is a dependency of your project — no wiring required. Drop a `cap-mcp-guard.yaml` in your project root and it's picked up automatically the next time your CAP server starts.

## Configure

```yaml
# cap-mcp-guard.yaml
mode: enforce   # or: observe (dry-run — logs/traces what would happen, blocks nothing)

entities:
  Orders:
    mask:
      - CreditCard
      - Salary
    maxRows: 100
    allowTools:
      - ReadOrders

  Customers:
    mask:
      - Email
      - Phone
```

- Entities not listed here are fully accessible — this is opt-in by design; you don't have to configure every entity up front.
- No config file at all? The guard runs in pass-through mode (a `console.warn` tells you so) rather than crashing your server.
- A config file that exists but fails to parse *does* fail loudly — a broken config shouldn't fail silently.

## What you get, per request

- **Masking** — in `enforce` mode, fields listed under `mask` are replaced with `'***MASKED***'` in the real response. In `observe` mode nothing is touched; the guard only computes what *would* happen.
- **Audit log** — every request produces a structured JSON line (Context + Decision), to stdout and/or a file you choose.
- **OpenTelemetry spans** — every request also becomes a real span via `@opentelemetry/api`. If your app already has an OTel SDK configured (any OTLP-compatible backend — Grafana, Jaeger, Datadog, SAP Cloud Logging), the guard's spans just show up there, correctly linked into the caller's trace via W3C Trace Context (`traceparent`/`tracestate`) when present — no extra mapping needed, because the context schema was built against OTel's GenAI semantic conventions (`gen_ai.*`) from the start.

All three run independently and can each be disabled per-call (`audit: false`, `otel: false`) if you're wiring `registerCapMcpGuard` yourself instead of relying on auto-discovery.

## Try it

A full working example lives in [`examples/bookshop`](examples/bookshop) — SAP's own CAP getting-started sample, with `cap-mcp-guard` wired in and a `cap-mcp-guard.yaml` masking real fields on `CatalogService.Books`.

```bash
cd examples/bookshop
npm install
npm test    # runs enforce/observe/audit/OTel integration tests against a real CAP service
npm start   # boots a real server at localhost:4004 — flip cap-mcp-guard.yaml to `mode: enforce`
            # and hit /odata/v4/browse/Books to see masking happen live
```

## Coming soon (not in v1)

- `@mcp.policy`-style CDS annotations as an alternative to `cap-mcp-guard.yaml`
- Approval workflows (human-in-the-loop for sensitive operations)
- Rate limiting and a dashboard UI
- Adapters for frameworks other than CAP
- Actually blocking a request when `allowTools`/`maxRows` is violated (today those are computed and reported, not enforced)

## Development

```bash
npm test   # unit tests for lib/core, lib/policy, lib/audit, lib/otel, lib/adapters
```

## License

MIT