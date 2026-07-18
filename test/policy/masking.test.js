'use strict';

const { maskFields, MASK_VALUE } = require('../../lib/policy/masking');

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
});