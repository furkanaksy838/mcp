'use strict';

const path = require('path');

const { attachInterceptor } = require('../core/interceptor');
const { loadConfig, NOT_CONFIGURED_PREFIX } = require('../policy/config');
const { logAudit } = require('../audit/log');
const { exportSpan } = require('../otel/exporter');

/**
 * Loads the `"cap-mcp-guard"` key from the host CAP project's package.json.
 * A missing package.json or a missing key is a valid "not configured yet"
 * state — falls back to a pass-through PolicyDefinition (every entity is
 * opt-in, so this is equivalent to no policy at all). A config that exists
 * but fails to parse is a user mistake and is NOT swallowed — it propagates
 * so the bad config gets noticed rather than silently ignored.
 *
 * @param {object} cds the @sap/cds module (used only for cds.root)
 */
function resolvePolicyDefinition(cds) {
  const configPath = path.join(cds.root || process.cwd(), 'package.json');

  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err.message.startsWith(NOT_CONFIGURED_PREFIX)) {
      console.warn('[cap-mcp-guard] no config found, running in pass-through mode (no policies enforced)');
      return { mode: 'observe', entities: {} };
    }
    throw err;
  }
}

/**
 * The single CAP-specific connection point in this package. Everything
 * under lib/core and lib/policy is framework-agnostic; this file is where
 * @sap/cds concepts (served services, cds.ApplicationService, cds.root)
 * are known.
 *
 * cds-plugin.js is the only caller of this function in production; tests
 * call it directly against a real or fake CAP service.
 *
 * @param {object} cds the @sap/cds module (or a compatible facade)
 * @param {object} [options] forwarded to attachInterceptor (see interceptor.js)
 * @param {object} [options.policyDefinition] when omitted, loaded from the
 *   `"cap-mcp-guard"` key in the project's package.json (see resolvePolicyDefinition)
 * @param {object|false} [options.audit] forwarded to logAudit()'s write
 *   options (`{ stdout, filePath }`); pass `false` to disable audit
 *   logging entirely.
 * @param {object|false} [options.otel] forwarded to exportSpan()'s options
 *   (`{ tracer }`); pass `false` to skip OTel span export entirely. With
 *   no host-configured OTel SDK this is already a harmless no-op, so the
 *   default is to always attempt it.
 * @param {(decision: object, context: object, req: object) => void} [options.onDecision]
 *   called in addition to the built-in audit log and OTel export, not
 *   instead of them — all that apply run for every request.
 *
 * `policyDefinition.services` (see lib/policy/config.js), when set, scopes the guard to
 * only the named served services — any other served ApplicationService is left completely
 * untouched (no interceptor attached at all, not even for observation/audit). This is how
 * you keep a human-facing UI service unmasked while guarding a separate AI/MCP-facing
 * service that projects the same entities. Omitted (the default) attaches to every served
 * ApplicationService, as before.
 */
function registerCapMcpGuard(cds, options = {}) {
  const policyDefinition = options.policyDefinition || resolvePolicyDefinition(cds);
  const { onDecision: userOnDecision, audit, otel } = options;

  const onDecision = (decision, context, req) => {
    if (audit !== false) logAudit(context, decision, audit);
    if (otel !== false) exportSpan(context, decision, otel);
    if (typeof userOnDecision === 'function') userOnDecision(decision, context, req);
  };

  cds.on('served', () => {
    for (const [name, srv] of Object.entries(cds.services)) {
      if (!(srv instanceof cds.ApplicationService)) continue;
      if (Array.isArray(policyDefinition.services) && !policyDefinition.services.includes(name)) continue;
      attachInterceptor(srv, { ...options, policyDefinition, onDecision });
    }
  });
}

module.exports = { registerCapMcpGuard };