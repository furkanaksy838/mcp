'use strict';

const path = require('path');

const { attachInterceptor } = require('../core/interceptor');
const { loadConfig } = require('../policy/config');
const { logAudit } = require('../audit/log');

const CONFIG_FILE_NAME = 'cap-mcp-guard.yaml';
const NOT_FOUND_PREFIX = `${CONFIG_FILE_NAME} not found`;

/**
 * Loads cap-mcp-guard.yaml from the host CAP project's root. A missing
 * config is a valid "not configured yet" state — falls back to a
 * pass-through PolicyDefinition (every entity is opt-in, so this is
 * equivalent to no policy at all). A config that exists but fails to
 * parse is a user mistake and is NOT swallowed — it propagates so the
 * bad config gets noticed rather than silently ignored.
 *
 * @param {object} cds the @sap/cds module (used only for cds.root)
 */
function resolvePolicyDefinition(cds) {
  const configPath = path.join(cds.root || process.cwd(), CONFIG_FILE_NAME);

  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err.message.startsWith(NOT_FOUND_PREFIX)) {
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
 * @param {object} [options.policyDefinition] when omitted, loaded from
 *   cap-mcp-guard.yaml at the project root (see resolvePolicyDefinition)
 * @param {object|false} [options.audit] forwarded to logAudit()'s write
 *   options (`{ stdout, filePath }`); pass `false` to disable audit
 *   logging entirely. Every request is still audited via onDecision if a
 *   caller-supplied one is given — both run.
 * @param {(decision: object, context: object, req: object) => void} [options.onDecision]
 *   called in addition to the built-in audit log, not instead of it
 */
function registerCapMcpGuard(cds, options = {}) {
  const policyDefinition = options.policyDefinition || resolvePolicyDefinition(cds);
  const { onDecision: userOnDecision, audit } = options;

  const onDecision = audit === false
    ? userOnDecision
    : (decision, context, req) => {
        logAudit(context, decision, audit);
        if (typeof userOnDecision === 'function') userOnDecision(decision, context, req);
      };

  cds.on('served', () => {
    for (const srv of Object.values(cds.services)) {
      if (srv instanceof cds.ApplicationService) {
        attachInterceptor(srv, { ...options, policyDefinition, onDecision });
      }
    }
  });
}

module.exports = { registerCapMcpGuard };