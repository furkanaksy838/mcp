'use strict';

const MASK_VALUE = '***MASKED***';
const MASK_CHAR = '*';

/**
 * Keeps `keepLeft` characters from the start and `keepRight` from the end, replacing everything
 * between them with `char` — the shape an operator expects from a rule table row that says
 * "IBAN, partial, 4, 4, *":
 *
 *   TR330006100519786457841326  ->  TR33******************1326
 *
 * Unlike a placeholder or a pseudonym, this *discloses real characters*. That is the whole point
 * (a human recognises their own account from the last four digits) and it is also the cost: an
 * agent reading `TR33...1326` has learned eight real characters, so this belongs on fields where
 * partial recognition is worth more than full concealment, not on fields that are simply secret.
 *
 * A value no longer than keepLeft+keepRight would come back fully visible, which is the one
 * outcome nobody asks for — so it is starred out entirely instead. Same for a value shorter than
 * either bound.
 */
function partialMask(value, { keepLeft = 0, keepRight = 0, char = MASK_CHAR } = {}) {
  const text = String(value);
  const kept = keepLeft + keepRight;

  if (text.length <= kept) return char.repeat(text.length);

  // slice(length - 0) is '' — deliberate, and why this isn't slice(-keepRight), which would
  // return the whole string when keepRight is 0.
  return text.slice(0, keepLeft) + char.repeat(text.length - kept) + text.slice(text.length - keepRight);
}

/**
 * Keeps the first character of the local part and the whole domain:
 *
 *   ahmet@firma.com  ->  a****@firma.com
 *
 * The domain survives because it is usually the part that carries no personal information and the
 * part an operator wants to keep for routing or grouping. Returns undefined for anything that
 * isn't shaped like an address — no '@', nothing before it, nothing after it — so the caller falls
 * back to a full mask rather than emitting a half-processed string. Guessing here would be the
 * wrong kind of clever: a malformed value is exactly when you least want to publish a prefix of it.
 */
function emailMask(value, { char = MASK_CHAR } = {}) {
  const text = String(value);
  const at = text.indexOf('@');

  if (at < 1 || at === text.length - 1) return undefined;

  return text[0] + char.repeat(Math.max(at - 1, 1)) + text.slice(at);
}

/**
 * Applies one mask rule to one real value.
 *
 * @param {*} value the real value
 * @param {object} [rule] {type, keepLeft, keepRight, char} — validated by lib/policy/config.js
 * @returns {string|undefined} the replacement, or undefined when the rule doesn't apply to this
 *   value (a non-email under type "email", or no rule at all) and the caller should fall back to
 *   the full-mask replacement
 */
function applyMaskRule(value, rule) {
  if (!rule || rule.type === 'full') return undefined;
  if (value === null || value === undefined) return undefined;

  if (rule.type === 'partial') return partialMask(value, rule);
  if (rule.type === 'email') return emailMask(value, rule);

  return undefined;
}

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
 *
 * A map entry may also be a function, which is how partial and email masking work: those depend
 * on the real value, so the replacement can only be computed per row rather than once per field.
 */
function resolveMaskValue(field, maskValue, currentValue) {
  if (maskValue !== null && typeof maskValue === 'object') {
    if (!(field in maskValue)) return MASK_VALUE;
    const entry = maskValue[field];
    return typeof entry === 'function' ? entry(currentValue) : entry;
  }
  return maskValue;
}

function maskOne(item, fieldsToMask, maskValue) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;

  const masked = { ...item };
  for (const field of fieldsToMask) {
    if (Object.prototype.hasOwnProperty.call(masked, field)) {
      masked[field] = resolveMaskValue(field, maskValue, masked[field]);
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
 *   a `{field: replacement}` map for per-field values (see resolveMaskValue). A map entry may be
 *   a function of the real value, for rules like partial that derive from it. Fields missing
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

module.exports = { maskFields, applyMaskRule, partialMask, emailMask, MASK_VALUE, MASK_CHAR };
