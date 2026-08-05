'use strict';

const MASK_VALUE = '***MASKED***';

/**
 * Resolves the replacement for one field.
 *
 * `maskValue` is either a single value used for every field, or a per-field map — the latter is
 * how type-aware masking works: '***MASKED***' is a string, and writing it into a field the
 * service declares as Edm.Decimal, Edm.Date or Edm.Boolean produces a payload that violates its
 * own $metadata. Typed consumers then can't render it at all (Fiori Elements shows an empty
 * cell, which reads as "no value" rather than "withheld"), so the caller decides per field and
 * passes the result in. A map entry may legitimately be `null`, hence the `in` check rather than
 * a truthiness test.
 */
function resolveMaskValue(field, maskValue) {
  if (maskValue !== null && typeof maskValue === 'object') {
    return field in maskValue ? maskValue[field] : MASK_VALUE;
  }
  return maskValue;
}

function maskOne(item, fieldsToMask, maskValue) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;

  const masked = { ...item };
  for (const field of fieldsToMask) {
    if (Object.prototype.hasOwnProperty.call(masked, field)) {
      masked[field] = resolveMaskValue(field, maskValue);
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
 * @param {string|object} [maskValue] the replacement: a single value applied to every field, or
 *   a `{field: replacement}` map for per-field values (see resolveMaskValue). Fields missing
 *   from the map fall back to '***MASKED***'. Defaults to '***MASKED***' for every field.
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
