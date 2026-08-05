'use strict';

const crypto = require('crypto');

const PSEUDONYM_TYPES = ['opaque', 'iban', 'uuid', 'custom'];

const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/;

function hmacHex(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Generic fallback: a deterministic, opaque token — same namespace+value+secret always
 * produces the same token, but the token carries no information about the real value
 * and doesn't resemble any particular data format.
 *
 * `namespace` is the field name by default, which scopes pseudonyms per field: the same real
 * value under two differently-named fields produces two different tokens. That is the right
 * default (it keeps unrelated fields from being correlated), but it breaks the case where the
 * *same* logical value is spelled differently across a model — `syd`, `soyad`, `lastName` —
 * and the agent is supposed to recognize them as one value. Passing an explicit `group`
 * (see generatePseudonym) substitutes it here, making the token identical across those fields.
 */
function generateOpaquePseudonym(namespace, value, secret) {
  const hex = hmacHex(`${namespace}:${value}`, secret);
  return `${namespace}-${hex.slice(0, 12)}`;
}

/**
 * Computes the 2-digit ISO 7064 MOD 97-10 check digits for an IBAN whose check-digit
 * positions (chars 3-4) are currently '00'. Standard algorithm: move the first 4 chars
 * to the end, map letters to numbers (A=10 .. Z=35), reduce mod 97 as a big integer via
 * BigInt, check digits = 98 - remainder.
 */
function computeIbanCheckDigits(ibanWithZeroedCheckDigits) {
  const rearranged = ibanWithZeroedCheckDigits.slice(4) + ibanWithZeroedCheckDigits.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const remainder = BigInt(numeric) % 97n;
  return String(98n - remainder).padStart(2, '0');
}

/**
 * Deterministic, format-preserving fake IBAN: same country code and total length as the
 * real value, digits derived from HMAC(value, secret), and a real, valid ISO 7064 MOD
 * 97-10 check digit pair — so it passes standard IBAN checksum validation even though
 * it's entirely fake. Falls back to generateOpaquePseudonym() for anything that doesn't
 * look like an IBAN (defensive — real-world field content can't be validated ahead of
 * time the way config shape can).
 */
function generateIbanPseudonym(value, secret, group) {
  const normalized = String(value).replace(/\s+/g, '').toUpperCase();

  if (!IBAN_SHAPE.test(normalized)) {
    // Namespaced by `group` when one is set, else by the constant 'IBAN' — never by the field
    // name, so this generator's "same value, same output" property holds across field names
    // for malformed values too, not just well-formed ones.
    return generateOpaquePseudonym(group || 'IBAN', value, secret);
  }

  const countryCode = normalized.slice(0, 2);
  const bbanLength = normalized.length - 4;

  const hex = hmacHex(normalized, secret);
  let digits = '';
  for (let i = 0; digits.length < bbanLength; i++) {
    const byte = parseInt(hex[i % hex.length], 16);
    digits += String(byte % 10);
  }
  digits = digits.slice(0, bbanLength);

  const withZeroedCheckDigits = `${countryCode}00${digits}`;
  const checkDigits = computeIbanCheckDigits(withZeroedCheckDigits);

  return `${countryCode}${checkDigits}${digits}`;
}

/**
 * Deterministic, syntactically valid UUID — the same namespace+value+secret always produces the
 * same one, with the version-4 and variant bits set so it passes GUID parsing and validation.
 *
 * This exists because the generic token (`opaque`) is a string like `person-id-0787abd9060d`, and
 * a field declared as UUID surfaces as Edm.Guid: handing that token back makes the response
 * contradict its own $metadata, and any client that actually parses GUIDs rejects it. Since the
 * usual way to link records across a model is a canonical id rather than a name — two people can
 * share a surname, they don't share an id — pseudonymized UUIDs are the case that has to keep
 * working, so it gets a format-preserving generator of its own, the same way `iban` does.
 */
function generateUuidPseudonym(namespace, value, secret) {
  const bytes = Buffer.from(hmacHex(`${namespace}:${value}`, secret).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const GENERATORS = {
  opaque: (field, value, secret, customValue, group) => generateOpaquePseudonym(group || field, value, secret),
  iban: (field, value, secret, customValue, group) => generateIbanPseudonym(value, secret, group),
  uuid: (field, value, secret, customValue, group) => generateUuidPseudonym(group || field, value, secret),
  // Not actually a generator — every row gets the exact same operator-chosen literal
  // instead of a derived fake value, so there's nothing to compute from value/secret.
  // (config.js rejects `group` here for the same reason.)
  custom: (field, value, secret, customValue) => customValue
};

/**
 * @param {string} field the field name being pseudonymized
 * @param {*} value the real value
 * @param {string} type one of PSEUDONYM_TYPES (validated by lib/policy/config.js)
 * @param {string} [secret] never embedded in the output; without it, the pseudonym can't
 *   be reproduced or (for the opaque/iban case) traced back to a specific value. Unused
 *   (and not required) for type "custom".
 * @param {string} [customValue] the literal replacement value, required and used only
 *   when type is "custom"
 * @param {string} [group] pseudonym namespace, replacing the field name in the derivation.
 *   Two fields sharing a group produce the same pseudonym for the same real value, however
 *   they are named — which is what makes one logical value recognizable to an agent across a
 *   model that spells it differently in different entities. Without it, "opaque" namespaces
 *   per field name (see generateOpaquePseudonym). Rejected for type "custom".
 * @returns {string}
 */
function generatePseudonym(field, value, type, secret, customValue, group) {
  const generator = GENERATORS[type];
  if (!generator) {
    throw new Error(`Unknown pseudonym type "${type}"`);
  }
  return generator(field, value, secret, customValue, group);
}

module.exports = { generatePseudonym, PSEUDONYM_TYPES };
