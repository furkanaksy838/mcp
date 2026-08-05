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

      // Not an error: masking a non-string field yields null, which is type-valid. But it reads as
      // "no value" to whoever consumes it, so it is worth saying out loud once at startup.
      if (fieldKind(element.type) !== 'string') {
        warnings.push(
          `${entityName}.${field}: masking a ${element.type} field yields null rather than ` +
            "'***MASKED***', since the placeholder is a string. Model it as text on the " +
            'agent-facing projection if the placeholder needs to be visible.'
        );
      }
    }
  }

  return { errors, warnings, groups };
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

module.exports = { lintPolicy, formatLintReport, GENERATOR_OUTPUT, FIELD_KIND };
