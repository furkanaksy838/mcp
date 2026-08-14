'use strict';

const { maskFields, applyMaskRule, partialMask, emailMask, MASK_VALUE } = require('../../lib/policy/masking');

describe('maskFields', () => {
  test('masks the specified fields on a single object', () => {
    const original = { ID: 1, title: 'Wuthering Heights', CreditCard: '4111-...' };
    const result = maskFields(original, ['CreditCard']);

    expect(result).toEqual({ ID: 1, title: 'Wuthering Heights', CreditCard: MASK_VALUE });
  });

  test('masks the specified fields on every element of an array', () => {
    const original = [
      { ID: 1, Salary: 90000 },
      { ID: 2, Salary: 120000 }
    ];
    const result = maskFields(original, ['Salary']);

    expect(result).toEqual([
      { ID: 1, Salary: MASK_VALUE },
      { ID: 2, Salary: MASK_VALUE }
    ]);
  });

  test('never mutates the original object', () => {
    const original = { ID: 1, CreditCard: '4111-...' };
    const snapshot = { ...original };

    const result = maskFields(original, ['CreditCard']);

    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
  });

  test('never mutates the original array or its elements', () => {
    const item1 = { ID: 1, Salary: 90000 };
    const original = [item1];

    const result = maskFields(original, ['Salary']);

    expect(original[0]).toBe(item1);
    expect(item1.Salary).toBe(90000);
    expect(result).not.toBe(original);
    expect(result[0]).not.toBe(item1);
  });

  test('fieldsToMask: [] returns an equivalent but new reference', () => {
    const original = { ID: 1, title: 'Dune' };
    const result = maskFields(original, []);

    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });

  test('returns null/undefined as-is without throwing', () => {
    expect(maskFields(null, ['CreditCard'])).toBeNull();
    expect(maskFields(undefined, ['CreditCard'])).toBeUndefined();
  });

  test('silently skips field names absent from the data, leaving other fields intact', () => {
    const original = { ID: 1, title: 'Dune' };
    const result = maskFields(original, ['NotAField', 'title']);

    expect(result).toEqual({ ID: 1, title: MASK_VALUE });
    expect(result).not.toHaveProperty('NotAField');
  });

  test('a function map entry is called with the real value, per row', () => {
    const original = [{ iban: 'TR330006100519786457841326' }, { iban: 'DE89370400440532013000' }];

    const result = maskFields(original, ['iban'], {
      iban: (value) => partialMask(value, { keepLeft: 4, keepRight: 4 })
    });

    expect(result).toEqual([
      { iban: 'TR33******************1326' },
      { iban: 'DE89**************3000' }
    ]);
  });
});

describe('partialMask', () => {
  // The example straight off the rule table: IBAN, partial, keepLeft 4, keepRight 4, char '*'.
  test('keeps the requested characters at each end and stars out the middle', () => {
    expect(partialMask('TR330006100519786457841326', { keepLeft: 4, keepRight: 4 })).toBe(
      'TR33******************1326'
    );
  });

  test('preserves length, so the replacement still looks like the field it stands in for', () => {
    const value = 'TR330006100519786457841326';
    expect(partialMask(value, { keepLeft: 4, keepRight: 4 })).toHaveLength(value.length);
  });

  test('keepRight: 0 keeps only the prefix — not the whole string', () => {
    expect(partialMask('123456', { keepLeft: 2 })).toBe('12****');
  });

  test('keepLeft: 0 keeps only the suffix', () => {
    expect(partialMask('123456', { keepRight: 2 })).toBe('****56');
  });

  test('no bounds at all is a full star-out, matching a bare "partial" rule', () => {
    expect(partialMask('123456')).toBe('******');
  });

  // The one outcome nobody configures a mask for: the value coming back completely readable.
  test('a value no longer than the kept bounds is starred out entirely', () => {
    expect(partialMask('1234', { keepLeft: 4, keepRight: 4 })).toBe('****');
    expect(partialMask('12345678', { keepLeft: 4, keepRight: 4 })).toBe('********');
    expect(partialMask('', { keepLeft: 4, keepRight: 4 })).toBe('');
  });

  test('honours a custom mask character', () => {
    expect(partialMask('123456', { keepLeft: 2, keepRight: 2, char: '#' })).toBe('12##56');
  });

  test('stringifies a non-string value rather than throwing', () => {
    expect(partialMask(1234567, { keepLeft: 2, keepRight: 2 })).toBe('12***67');
  });
});

describe('emailMask', () => {
  test('keeps the first character of the local part and the whole domain', () => {
    expect(emailMask('ahmet@firma.com')).toBe('a****@firma.com');
  });

  test('a single-character local part still gets one mask character, not a bare address', () => {
    expect(emailMask('a@firma.com')).toBe('a*@firma.com');
  });

  test('honours a custom mask character', () => {
    expect(emailMask('ahmet@firma.com', { char: '#' })).toBe('a####@firma.com');
  });

  // A malformed value is exactly when you least want to publish a prefix of it, so the caller is
  // told to fall back to the full replacement instead.
  test('returns undefined for anything not shaped like an address', () => {
    expect(emailMask('not-an-email')).toBeUndefined();
    expect(emailMask('@firma.com')).toBeUndefined();
    expect(emailMask('ahmet@')).toBeUndefined();
    expect(emailMask('')).toBeUndefined();
  });
});

describe('applyMaskRule', () => {
  test('no rule, or type "full", means "use the placeholder"', () => {
    expect(applyMaskRule('x', undefined)).toBeUndefined();
    expect(applyMaskRule('x', { type: 'full' })).toBeUndefined();
  });

  test('dispatches to the partial and email strategies', () => {
    expect(applyMaskRule('123456', { type: 'partial', keepLeft: 2, keepRight: 2 })).toBe('12**56');
    expect(applyMaskRule('ahmet@firma.com', { type: 'email' })).toBe('a****@firma.com');
  });

  // Star-out of an absent value would invent a length that isn't there; null stays null and the
  // caller substitutes the placeholder for the field's type.
  test('null and undefined fall through to the placeholder', () => {
    expect(applyMaskRule(null, { type: 'partial', keepLeft: 2 })).toBeUndefined();
    expect(applyMaskRule(undefined, { type: 'email' })).toBeUndefined();
  });

  test('an unknown type falls through rather than passing the real value along', () => {
    expect(applyMaskRule('secret', { type: 'tckn' })).toBeUndefined();
  });
});