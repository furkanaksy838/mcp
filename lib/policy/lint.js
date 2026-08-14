'use strict';

// What each generator's output actually is, so it can be checked against the type the service
// publishes for the field it is written into.
const GENERATOR_OUTPUT = {
  opaque: 'string',
  iban: 'string',
  custom: 'string',
  uuid: 'uuid'
};

// Which CDS element types can hold which generator output. A field has exactly one type — the one
// in $metadata — so a mismatch means the response contradicts its own metadata and typed clients
// reject or silently drop the value.
const FIELD_KIND = {
  'cds.String': 'string',
  'cds.LargeString': 'string',
  'cds.UUID': 'uuid'
};

function fieldKind(elementType) {
  return FIELD_KIND[elementType] || 'other';
}

// CAP's development authentication strategies. None of them verify who the caller is: `dummy`
// authenticates nobody and privileges everybody, and `mocked`/`basic` accept a name against a
// list that CAP seeds with `"*": true` — so a request presenting a name nobody configured is
// accepted as that name.
//
// Deliberately a blocklist of the known development kinds rather than an allowlist of trusted
// ones: a project with a custom `impl` made a deliberate choice, and a warning that fires on
// every bespoke auth strategy is a warning people learn to scroll past.
const UNVERIFIED_AUTH_KINDS = new Set(['dummy', 'mocked', 'mock', 'basic']);

/**
 * Checks identity-based scoping against the authentication that is actually configured.
 *
 * `"users"` asks the guard to decide policy from `req.user.id`, which makes the whole policy only
 * as trustworthy as whatever established that id. Under a development auth strategy nothing did:
 * an agent that sends a name not in the list reads every masked field in the clear, the audit log
 * records the request as plainly allowed with nothing to mask, and no part of the running system
 * indicates that the policy stopped applying. That silence is the reason this is checked at
 * startup instead of being left to be discovered.
 *
 * Says nothing when `"users"` isn't configured — then identity plays no part in the policy and the
 * auth strategy is none of the guard's business.
 *
 * @param {object} policyDefinition see lib/policy/config.js
 * @param {string} [authKind] the configured strategy (CAP: cds.env.requires.auth.kind)
 * @returns {string|undefined} the warning, or undefined when there is nothing to say
 */
function lintIdentityScoping(policyDefinition, authKind) {
  const users = policyDefinition && policyDefinition.users;
  if (!Array.isArray(users) || users.length === 0) return undefined;
  if (!authKind || !UNVERIFIED_AUTH_KINDS.has(String(authKind).toLowerCase())) return undefined;

  return (
    `"users" scopes this policy by caller identity (${users.map((u) => JSON.stringify(u)).join(', ')}), ` +
    `but the configured auth strategy is "${authKind}", which does not verify who the caller is — ` +
    'a request presenting any other name reads every masked field in the clear, and nothing at ' +
    'runtime reports that it did. Fine while developing. Before production either switch to a real ' +
    'identity provider (XSUAA, IAS, or any JWT-validating strategy), or move the boundary into the ' +
    'URL by serving the agent its own service or its own entity, which has no identity to imitate.'
  );
}

/**
 * Checks a merged PolicyDefinition against the model it will run on, and returns findings.
 *
 * The checks are deliberately limited to what a machine can actually decide. "Is this field bound
 * to the right semantic group?" cannot be — a linter can't know that `Customers.surname` and
 * `Employees.syd` are the same concept, only that they claim to be. What it *can* decide is
 * whether the value the guard will produce fits the field it goes into, and that is exactly the
 * class of defect that stays invisible at runtime: the payload looks masked, and the consumer
 * shows an empty cell or throws a parse error somewhere else entirely.
 *
 * Pure: takes plain data, returns plain data, knows nothing about CAP. The adapter collects the
 * elements map from the served model and decides what to do with the findings.
 *
 * @param {object} policyDefinition merged policy (see lib/policy/config.js)
 * @param {object} elementsByEntity {entityName: {field: {type}}} — compiled elements per entity;
 *   entities absent from it are skipped rather than guessed at
 * @returns {{errors: string[], warnings: string[], groups: object}} groups maps a pseudonym group
 *   name to the `Entity.field` list using it — the report that makes an accidental split or an
 *   accidental join visible at a glance
 */
function lintPolicy(policyDefinition, elementsByEntity = {}) {
  const typeSafe = policyDefinition.maskTypeSafe !== false;
  const maskValue = policyDefinition.maskValue || '***MASKED***';
  const errors = [];
  const warnings = [];
  const groups = {};

  for (const [entityName, config] of Object.entries(policyDefinition.entities || {})) {
    const elements = elementsByEntity[entityName];

    for (const entry of config.pseudonymize || []) {
      if (entry.group) {
        groups[entry.group] = groups[entry.group] || [];
        groups[entry.group].push(`${entityName}.${entry.field}`);
      }

      const element = elements && elements[entry.field];
      if (!element) continue;

      const produced = GENERATOR_OUTPUT[entry.type];
      const holds = fieldKind(element.type);

      if (produced && holds !== produced) {
        errors.push(
          `${entityName}.${entry.field}: pseudonymize type "${entry.type}" produces a ${produced}, ` +
            `but the field is ${element.type}. ` +
            (holds === 'uuid'
              ? 'Use type "uuid" for a UUID field.'
              : holds === 'string'
                ? 'Use type "opaque", "iban" or "custom" for a string field.'
                : 'A value of this type cannot be pseudonymized — use "mask", or model the ' +
                  'agent-facing projection\'s field as text.')
        );
      }
    }

    for (const field of config.mask || []) {
      const element = elements && elements[field];
      if (!element) continue;

      const rule = (config.maskRules || {})[field];
      if (fieldKind(element.type) === 'string') continue;

      // partial and email derive a *string* from the real value, so a non-string field can't hold
      // the result at all — it silently falls back to the full replacement, which is not what the
      // rule asked for. An error rather than a warning: the configured strategy simply won't run.
      if (rule) {
        errors.push(
          `${entityName}.${field}: mask type "${rule.type}" produces a string, but the field is ` +
            `${element.type}, so the rule cannot apply. Mask it fully, or model the field as text ` +
            'on the agent-facing projection.'
        );
        continue;
      }

      // Neither case is an error — both are legitimate, they just trade different things away, and
      // which one is in force is invisible at runtime until someone looks at a payload.
      warnings.push(
        typeSafe
          ? `${entityName}.${field}: masking a ${element.type} field yields null rather than ` +
              `${JSON.stringify(maskValue)}, since the placeholder is a string. Set ` +
              '"maskTypeSafe": false, or model the field as text on the agent-facing projection, ' +
              'if the placeholder needs to be visible.'
          : `${entityName}.${field}: "maskTypeSafe" is off, so this ${element.type} field is ` +
              `masked to the string ${JSON.stringify(maskValue)} and the response contradicts its ` +
              'own $metadata. Fine for a JSON-reading agent, not for a typed client such as Fiori.'
      );
    }
  }

  return { errors, warnings, groups };
}

/**
 * Checks path scoping for the half of it that config alone cannot supply.
 *
 * `"paths"` decides what happens to requests arriving at the doors it names. It says nothing about
 * the other doors — and the same entities are still served there, now with no policy applying at
 * all. So a policy scoped to `/mcp`, on a service that anyone can also read at `/odata/v4/...`,
 * masks nothing that matters: the caller asks the other URL and gets real values. Worse than
 * `"users"`, which at least follows the identity wherever it appears.
 *
 * What makes this checkable rather than merely worth documenting is that the other door's lock is
 * declared in the model: CAP's own `@requires`/`@restrict` on the service or the entity. If neither
 * carries one, the gap is certain rather than suspected, and it is invisible at runtime — every
 * request at the unprotected door returns 200 with real data, which is indistinguishable from an
 * entity that was never meant to be masked.
 *
 * @param {object} policyDefinition see lib/policy/config.js
 * @param {object} [authByEntity] {entityName: {service: boolean, entity: boolean}} — whether an
 *   authorization annotation was found on the entity's service and on the entity itself. Entities
 *   absent from it are skipped rather than guessed at.
 * @returns {string|undefined}
 */
function lintPathScoping(policyDefinition, authByEntity = {}) {
  const paths = policyDefinition && policyDefinition.paths;
  if (!Array.isArray(paths) || paths.length === 0) return undefined;

  // The check can only read the model, and the other doors are just as legitimately closed by an
  // ingress rule or an express middleware — neither of which is visible here. So there has to be a
  // way to say "handled, elsewhere": without one, this would fire at a correctly-configured project
  // and, under lint.strict, refuse to start it. A warning that goes off when you did the right thing
  // is a warning people stop reading.
  if (policyDefinition.otherSurfacesGated) return undefined;

  const unprotected = Object.keys(policyDefinition.entities || {})
    .filter((name) => {
      const auth = authByEntity[name];
      return auth && !auth.service && !auth.entity;
    })
    .sort();

  if (unprotected.length === 0) return undefined;

  return (
    `policy is scoped to path ${paths.map((p) => JSON.stringify(p)).join(', ')}, but ` +
    `${unprotected.join(', ')} carr${unprotected.length === 1 ? 'ies' : 'y'} no @requires/@restrict ` +
    'naming a real role — the same rows are readable unmasked through the service\'s own URL by ' +
    'anyone who can reach it, because the policy does not apply there. Path scoping masks the door ' +
    'it names; the other doors are authorization, so close them on a role the agent does not hold. ' +
    'This check reads the model only: if an ingress rule or a middleware already closes them, set ' +
    '"otherSurfacesGated": true to say so.'
  );
}

/**
 * Renders lintPolicy()'s output as lines for a startup log — the group map first, since that is
 * what makes a mistyped or duplicated group obvious, then warnings, then errors.
 *
 * @param {{errors: string[], warnings: string[], groups: object}} findings
 * @returns {string[]}
 */
function formatLintReport(findings) {
  const lines = [];
  const groupNames = Object.keys(findings.groups).sort();

  if (groupNames.length > 0) {
    lines.push('pseudonym groups:');
    for (const name of groupNames) {
      lines.push(`  ${name}`);
      for (const field of findings.groups[name].slice().sort()) {
        lines.push(`    - ${field}`);
      }
    }
  }

  for (const warning of findings.warnings) lines.push(`warning: ${warning}`);
  for (const error of findings.errors) lines.push(`error: ${error}`);

  return lines;
}

module.exports = {
  lintPolicy,
  lintIdentityScoping,
  lintPathScoping,
  formatLintReport,
  GENERATOR_OUTPUT,
  FIELD_KIND,
  UNVERIFIED_AUTH_KINDS
};
