'use strict';

/**
 * Evaluates a request Context (lib/core/context.js) against a
 * PolicyDefinition (lib/policy/config.js) and produces a Decision — what
 * *should* happen for this request. Nothing is enforced here: no fields are
 * removed, no request is blocked, nothing is logged. Those are M4 (masking)
 * and M5 (audit)'s job.
 *
 * Pure function: same inputs, same output. No CAP dependency.
 *
 * @param {object} context see lib/core/context.js buildContext() shape
 * @param {object} policyDefinition see lib/policy/config.js parseConfig() shape
 * @returns {object} Decision
 */
function evaluate(context, policyDefinition) {
  const entityConfig = policyDefinition.entities[context.entity];

  if (!entityConfig) {
    return {
      mode: policyDefinition.mode,
      allowed: true,
      reason: null,
      fieldsToMask: [],
      rowLimitExceeded: false,
      maxRows: null,
      entity: context.entity,
      timestamp: context.timestamp
    };
  }

  const { allowTools, maxRows, mask } = entityConfig;

  let allowed = true;
  let reason = null;
  if (Array.isArray(allowTools) && !allowTools.includes(context.operation)) {
    allowed = false;
    reason = `tool '${context.operation}' not in allowTools for entity '${context.entity}'`;
  }

  const rowLimitExceeded =
    typeof maxRows === 'number' && typeof context.rowCount === 'number' && context.rowCount > maxRows;

  return {
    mode: policyDefinition.mode,
    allowed,
    reason,
    fieldsToMask: mask ?? [],
    rowLimitExceeded,
    maxRows: typeof maxRows === 'number' ? maxRows : null,
    entity: context.entity,
    timestamp: context.timestamp
  };
}

module.exports = { evaluate };