'use strict';

const crypto = require('crypto');

const PSEUDONYM_TYPES = ['opaque', 'iban', 'custom'];

const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/;

function hmacHex(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Generic fallback: a deterministic, opaque token — same field+value+secret always
 * produces the same token, but the token carries no information about the real value
 * and doesn't resemble any particular data format.
 */
function generateOpaquePseudonym(field, value, secret) {
  const hex = hmacHex(`${field}:${value}`, secret);
  return `${field}-${hex.slice(0, 12)}`;
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
function generateIbanPseudonym(value, secret) {
  const normalized = String(value).replace(/\s+/g, '').toUpperCase();

  if (!IBAN_SHAPE.test(normalized)) {
    return generateOpaquePseudonym('IBAN', value, secret);
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

const GENERATORS = {
  opaque: generateOpaquePseudonym,
  iban: (field, value, secret) => generateIbanPseudonym(value, secret),
  // Not actually a generator — every row gets the exact same operator-chosen literal
  // instead of a derived fake value, so there's nothing to compute from value/secret.
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
 * @returns {string}
 */
function generatePseudonym(field, value, type, secret, customValue) {
  const generator = GENERATORS[type];
  if (!generator) {
    throw new Error(`Unknown pseudonym type "${type}"`);
  }
  return generator(field, value, secret, customValue);
}

module.exports = { generatePseudonym, PSEUDONYM_TYPES };
