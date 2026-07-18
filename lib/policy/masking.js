'use strict';

const MASK_VALUE = '***MASKED***';

function maskOne(item, fieldsToMask, maskValue) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;

  const masked = { ...item };
  for (const field of fieldsToMask) {
    if (Object.prototype.hasOwnProperty.call(masked, field)) {
      masked[field] = maskValue;
    }
  }
  return masked;
}

/**
 * Replaces the given fields' values with a mask placeholder. Pure and
 * immutable: never mutates `data`, always returns a new object/array. No
 * CAP dependency — operates on plain data.
 *
 * @param {object|object[]|null|undefined} data
 * @param {string[]} fieldsToMask field names to redact (from Decision.fieldsToMask)
 * @param {string} [maskValue] placeholder value, defaults to '***MASKED***'
 * @returns {object|object[]|null|undefined} a new object/array with masked fields
 */
function maskFields(data, fieldsToMask, maskValue = MASK_VALUE) {
  if (data === null || data === undefined) return data;

  const fields = fieldsToMask || [];

  if (Array.isArray(data)) {
    return data.map((item) => maskOne(item, fields, maskValue));
  }

  return maskOne(data, fields, maskValue);
}

module.exports = { maskFields, MASK_VALUE };