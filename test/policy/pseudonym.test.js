'use strict';

const { generatePseudonym, PSEUDONYM_TYPES } = require('../../lib/policy/pseudonym');

/**
 * Independent re-implementation of ISO 7064 MOD 97-10 IBAN checksum validation —
 * written directly here (not imported from lib/policy/pseudonym.js) so this test
 * actually proves generateIbanPseudonym()'s output is a genuinely valid IBAN, rather
 * than just checking the module agrees with itself.
 */
function isValidIbanChecksum(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  return BigInt(numeric) % 97n === 1n;
}

describe('PSEUDONYM_TYPES', () => {
  test('includes "opaque" and "iban"', () => {
    expect(PSEUDONYM_TYPES).toEqual(expect.arrayContaining(['opaque', 'iban']));
  });
});

describe('generatePseudonym — opaque', () => {
  test('is deterministic: same field/value/secret always produces the same token', () => {
    const a = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-1');
    const b = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-1');
    expect(a).toBe(b);
  });

  test('different values produce different tokens', () => {
    const a = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-1');
    const b = generatePseudonym('Email', 'bob@example.com', 'opaque', 'secret-1');
    expect(a).not.toBe(b);
  });

  test('different secrets produce different tokens for the same value', () => {
    const a = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-1');
    const b = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-2');
    expect(a).not.toBe(b);
  });

  test('is prefixed with the field name and never contains the real value', () => {
    const result = generatePseudonym('Email', 'alice@example.com', 'opaque', 'secret-1');
    expect(result.startsWith('Email-')).toBe(true);
    expect(result).not.toContain('alice');
  });
});

describe('generatePseudonym — iban', () => {
  const REAL_IBAN = 'DE89370400440532013000';

  test('is deterministic: same real IBAN + secret always produces the same fake IBAN', () => {
    const a = generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1');
    const b = generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1');
    expect(a).toBe(b);
  });

  test('different real IBANs produce different fake IBANs', () => {
    const a = generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1');
    const b = generatePseudonym('IBAN', 'FR1420041010050500013M02606', 'iban', 'secret-1');
    expect(a).not.toBe(b);
  });

  test('the fake IBAN is never the real value, and passes IBAN checksum validation', () => {
    const fake = generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1');
    expect(fake).not.toBe(REAL_IBAN);
    expect(isValidIbanChecksum(fake)).toBe(true);
  });

  test('preserves the country code and total length of the real IBAN', () => {
    const fake = generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1');
    expect(fake.slice(0, 2)).toBe('DE');
    expect(fake.length).toBe(REAL_IBAN.length);
  });

  test('tolerates spaces and lowercase in the real value the same way', () => {
    const spaced = 'de89 3704 0044 0532 0130 00';
    const fake = generatePseudonym('IBAN', spaced, 'iban', 'secret-1');
    expect(fake).toBe(generatePseudonym('IBAN', REAL_IBAN, 'iban', 'secret-1'));
  });

  test('falls back to the opaque generator for a value that does not look like an IBAN', () => {
    const fake = generatePseudonym('IBAN', 'not-an-iban', 'iban', 'secret-1');
    expect(fake.startsWith('IBAN-')).toBe(true);
  });
});

describe('generatePseudonym — unknown type', () => {
  test('throws for a type outside PSEUDONYM_TYPES', () => {
    expect(() => generatePseudonym('IBAN', 'x', 'not-a-real-type', 'secret-1')).toThrow(
      'Unknown pseudonym type "not-a-real-type"'
    );
  });
});
