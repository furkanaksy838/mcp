'use strict';

const fs = require('fs');
const path = require('path');

const { attachInterceptor } = require('../core/interceptor');
const { loadConfig, validateEntityConfig, NOT_CONFIGURED_PREFIX } = require('../policy/config');
const { mergeAnnotationsIntoPolicy } = require('./annotations');
const { lintPolicy, lintIdentityScoping, formatLintReport } = require('../policy/lint');
const { logAudit } = require('../audit/log');
const { exportSpan } = require('../otel/exporter');

// Versions before 0.3.0 read policy from this file instead of package.json. It is no
// longer read at all — see resolvePolicyDefinition()'s legacy-file check below, which
// exists specifically so an unmigrated project fails loudly instead of silently running
// with zero enforcement.
const LEGACY_YAML_FILENAME = 'cap-mcp-guard.yaml';

/**
 * Loads the `"cap-mcp-guard"` key from the host CAP project's package.json.
 * A missing package.json or a missing key is a valid "not configured yet"
 * state — falls back to a pass-through PolicyDefinition (every entity is
 * opt-in, so this is equivalent to no policy at all), UNLESS a legacy
 * `cap-mcp-guard.yaml` is sitting right there (see LEGACY_YAML_FILENAME): that
 * almost certainly means an unmigrated pre-0.3.0 project, and starting up
 * silently unenforced would be worse than refusing to start. A config that
 * exists but fails to parse is a user mistake and is NOT swallowed either —
 * it propagates so the bad config gets noticed rather than silently ignored.
 *
 * @param {object} cds the @sap/cds module (used only for cds.root)
 */
function resolvePolicyDefinition(cds) {
  const root = cds.root || process.cwd();
  const configPath = path.join(root, 'package.json');

  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err.message.startsWith(NOT_CONFIGURED_PREFIX)) {
      const legacyYamlPath = path.join(root, LEGACY_YAML_FILENAME);
      if (fs.existsSync(legacyYamlPath)) {
        throw new Error(
          `[cap-mcp-guard] found "${LEGACY_YAML_FILENAME}" at ${legacyYamlPath}, but this file has not been read ` +
            'since 0.3.0 — config now lives under the "cap-mcp-guard" key in package.json. Move its contents there ' +
            '(or delete the file, if you no longer want a policy) before starting the server. Refusing to start ' +
            'rather than run with zero enforcement silently.'
        );
      }
      console.warn('[cap-mcp-guard] no config found, running in pass-through mode (no policies enforced)');
      return { mode: 'observe', entities: {} };
    }
    throw err;
  }
}

/**
 * Throws when policyDefinition.entities configures `pseudonymize` anywhere with a type
 * other than "custom" (which needs no secret, since it isn't derived from one) and no
 * secret is available. Shared by the two points this needs checking: once synchronously
 * at registerCapMcpGuard() (package.json/explicit-option config only, so the common,
 * no-annotations case still fails fast before cds.on('served') even fires), and again
 * after @mcp.policy annotations are merged in (server-side, since annotations can only be
 * read once the model is compiled — see mergeAnnotationsIntoPolicy()).
 */
function assertPseudonymSecret(policyDefinition, pseudonymSecret) {
  const needsPseudonymSecret = Object.values(policyDefinition.entities).some((entityConfig) =>
    (entityConfig.pseudonymize || []).some((entry) => entry.type !== 'custom')
  );
  if (needsPseudonymSecret && !pseudonymSecret) {
    throw new Error(
      'CAP_MCP_GUARD_PSEUDONYM_SECRET env var (or options.pseudonymSecret) is required when "pseudonymize" is configured'
    );
  }
}

/**
 * Collects `{entityName: elements}` for every served entity, keyed the way policyDefinition.entities
 * is (see interceptor.js#resolveEntity). This is the CAP-shaped input lintPolicy() needs and the
 * reason the lint itself can stay in lib/policy without knowing about @sap/cds.
 */
function collectElements(cds) {
  const byEntity = {};
  for (const srv of Object.values((cds && cds.services) || {})) {
    for (const [name, entityDef] of Object.entries((srv && srv.entities) || {})) {
      if (!entityDef || !entityDef.elements) continue;
      byEntity[entityDef.name || name] = entityDef.elements;
    }
  }
  return byEntity;
}

/**
 * Runs the policy lint (see lib/policy/lint.js) against the served model and reports it.
 *
 * Off unless asked for: `lint: true` logs the pseudonym-group map and any findings once at
 * startup; `lint: { strict: true }` additionally refuses to start when there are errors. The
 * findings are things a running system won't tell you — a pseudonym written into a field whose
 * type can't hold it looks fine in the guard's own audit log and only breaks at the consumer, and
 * two entities meant to share a group but differing by a typo simply never match.
 *
 * @param {object} cds
 * @param {object} policyDefinition merged policy
 * @param {boolean|{strict?: boolean}} [lint]
 */
function runPolicyLint(cds, policyDefinition, lint) {
  if (!lint) return;

  const findings = lintPolicy(policyDefinition, collectElements(cds));
  const lines = formatLintReport(findings);

  for (const line of lines) {
    console.log(`[cap-mcp-guard] ${line}`);
  }

  const strict = typeof lint === 'object' && lint.strict;
  if (strict && findings.errors.length > 0) {
    throw new Error(
      `[cap-mcp-guard] policy lint failed with ${findings.errors.length} error(s) and lint.strict is set:\n` +
        findings.errors.map((e) => `  - ${e}`).join('\n')
    );
  }
}

/**
 * Reports identity-based scoping that rests on an authentication strategy which cannot carry it
 * (see lint.js#lintIdentityScoping).
 *
 * Unlike runPolicyLint(), this is NOT gated on `lint` being switched on. Every other finding is
 * about a payload being shaped wrongly, which the person who asked for the lint is the one who
 * wants to hear about. This one is about the policy silently not applying at all, and someone who
 * never enabled the lint is exactly who needs telling. `lint: { strict: true }` still upgrades it
 * to a refusal, which is how a production pipeline can make sure the warning was acted on.
 *
 * @param {object} cds read only for cds.env.requires.auth.kind
 * @param {object} policyDefinition merged policy
 * @param {boolean|{strict?: boolean}} [lint]
 */
function reportIdentityScoping(cds, policyDefinition, lint) {
  const auth = cds && cds.env && cds.env.requires && cds.env.requires.auth;
  const warning = lintIdentityScoping(policyDefinition, auth && auth.kind);
  if (!warning) return;

  console.warn(`[cap-mcp-guard] warning: ${warning}`);

  if (typeof lint === 'object' && lint !== null && lint.strict) {
    throw new Error(`[cap-mcp-guard] refusing to start with lint.strict set: ${warning}`);
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
 *   logging entirely. When omitted, falls back to the `"audit"` key parsed
 *   from package.json's `"cap-mcp-guard"` config (see lib/policy/config.js) —
 *   this is what lets `audit.filePath` be set through config alone, without
 *   hand-writing a registerCapMcpGuard() call.
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
 *
 * @param {string} [options.pseudonymSecret] used to derive pseudonyms (see
 *   lib/policy/pseudonym.js) for any entity configuring `pseudonymize`; when omitted,
 *   falls back to the `CAP_MCP_GUARD_PSEUDONYM_SECRET` env var. If any entity uses
 *   `pseudonymize` and neither is set, this throws immediately (at server boot, before
 *   any request can be served) rather than silently producing unprotected data.
 */
function registerCapMcpGuard(cds, options = {}) {
  const basePolicyDefinition = options.policyDefinition || resolvePolicyDefinition(cds);
  const { onDecision: userOnDecision, otel } = options;
  const audit = options.audit !== undefined ? options.audit : basePolicyDefinition.audit;
  const lint = options.lint !== undefined ? options.lint : basePolicyDefinition.lint;

  // type: "custom" is a fixed, operator-chosen literal, not a derived value — it needs no
  // secret to reproduce, so a config using only "custom" entries can start without one.
  const pseudonymSecret = options.pseudonymSecret || process.env.CAP_MCP_GUARD_PSEUDONYM_SECRET;

  // Fails fast, synchronously, for the common case (no @mcp.policy annotations at all) —
  // before cds.on('served') even needs to fire.
  assertPseudonymSecret(basePolicyDefinition, pseudonymSecret);

  const onDecision = (decision, context, req) => {
    if (audit !== false) logAudit(context, decision, audit);
    if (otel !== false) exportSpan(context, decision, otel);
    if (typeof userOnDecision === 'function') userOnDecision(decision, context, req);
  };

  cds.on('served', () => {
    // @mcp.policy CDS annotations (see lib/adapters/annotations.js) are only readable once
    // the model is compiled and services are served — merged in here, never touching
    // mode/services/users/audit, only per-entity mask/pseudonymize/maxRows/allowTools.
    const policyDefinition = mergeAnnotationsIntoPolicy(cds, basePolicyDefinition, validateEntityConfig);
    // Annotations can introduce a pseudonymize need the synchronous check above couldn't
    // have seen yet — re-checked here, still before any request is actually served.
    assertPseudonymSecret(policyDefinition, pseudonymSecret);

    reportIdentityScoping(cds, policyDefinition, lint);
    runPolicyLint(cds, policyDefinition, lint);

    for (const [name, srv] of Object.entries(cds.services)) {
      if (!(srv instanceof cds.ApplicationService)) continue;
      if (Array.isArray(policyDefinition.services) && !policyDefinition.services.includes(name)) continue;
      attachInterceptor(srv, { ...options, policyDefinition, onDecision, pseudonymSecret });
    }
  });
}

module.exports = { registerCapMcpGuard };