'use strict';

const { readEntityAnnotations, scanAnnotations, mergeEntityConfig, mergeAnnotationsIntoPolicy } = require('../../lib/adapters/annotations');
const { validateEntityConfig } = require('../../lib/policy/config');

describe('readEntityAnnotations', () => {
  test('returns undefined for an entity with no @mcp.policy annotations at all', () => {
    expect(readEntityAnnotations({ elements: { ID: { type: 'cds.Integer' } } })).toBeUndefined();
    expect(readEntityAnnotations(undefined)).toBeUndefined();
  });

  test('collects a field flagged @mcp.policy.mask into "mask"', () => {
    const entityDef = {
      elements: {
        ID: { type: 'cds.Integer' },
        salary: { type: 'cds.Decimal', '@mcp.policy.mask': true }
      }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({ mask: ['salary'] });
  });

  // `iban @mcp.policy.mask: {type:'partial', keepLeft:4, keepRight:4};` — the same flattening trap
  // as pseudonymize: CDS never stores the object under the unsuffixed key, so a reader that only
  // checks `element['@mcp.policy.mask'] === true` sees nothing and leaves the field unprotected.
  test('a mask annotation carrying a strategy arrives as flattened dotted keys', () => {
    const entityDef = {
      elements: {
        iban: {
          type: 'cds.String',
          '@mcp.policy.mask.type': 'partial',
          '@mcp.policy.mask.keepLeft': 4,
          '@mcp.policy.mask.keepRight': 4,
          '@mcp.policy.mask.char': '*'
        }
      }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      mask: [{ field: 'iban', type: 'partial', keepLeft: 4, keepRight: 4, char: '*' }]
    });
  });

  test('a mask annotation with only a type reads as that type', () => {
    const entityDef = { elements: { email: { type: 'cds.String', '@mcp.policy.mask.type': 'email' } } };
    expect(readEntityAnnotations(entityDef)).toEqual({ mask: [{ field: 'email', type: 'email' }] });
  });

  test('still accepts a nested mask object, which CDS does not emit today', () => {
    const entityDef = {
      elements: { iban: { type: 'cds.String', '@mcp.policy.mask': { type: 'partial', keepLeft: 2 } } }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      mask: [{ field: 'iban', type: 'partial', keepLeft: 2 }]
    });
  });

  test('a strategy annotation validates through the same rules as package.json', () => {
    const raw = readEntityAnnotations({
      elements: { iban: { type: 'cds.String', '@mcp.policy.mask.type': 'partial', '@mcp.policy.mask.keepLeft': 4 } }
    });
    expect(validateEntityConfig('Employees', raw)).toMatchObject({
      mask: ['iban'],
      maskRules: { iban: { type: 'partial', keepLeft: 4 } }
    });

    const bad = readEntityAnnotations({
      elements: { tckn: { type: 'cds.String', '@mcp.policy.mask.type': 'tckn' } }
    });
    expect(() => validateEntityConfig('Employees', bad)).toThrow(
      'entities.Employees.mask.tckn.type must be one of full, partial, email'
    );
  });

  test('mixes a plain mask and a strategy mask on one entity', () => {
    const entityDef = {
      elements: {
        salary: { type: 'cds.Decimal', '@mcp.policy.mask': true },
        email: { type: 'cds.String', '@mcp.policy.mask.type': 'email' }
      }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      mask: ['salary', { field: 'email', type: 'email' }]
    });
  });

  test('a field annotated with a bare-string pseudonymize type becomes a {field, type} entry', () => {
    const entityDef = { elements: { iban: { type: 'cds.String', '@mcp.policy.pseudonymize': 'iban' } } };
    expect(readEntityAnnotations(entityDef)).toEqual({ pseudonymize: [{ field: 'iban', type: 'iban' }] });
  });

  // What CDS actually compiles `@mcp.policy.pseudonymize: {type:'custom', value:'Redacted'}` to:
  // flattened dotted keys, NOT a nested object. Reading only the unsuffixed key — as this
  // adapter used to — finds nothing and silently leaves the field unprotected.
  test('a field annotated with an object gets it as flattened dotted keys, the way CDS emits them', () => {
    const entityDef = {
      elements: {
        name: {
          type: 'cds.String',
          '@mcp.policy.pseudonymize.type': 'custom',
          '@mcp.policy.pseudonymize.value': 'Redacted'
        }
      }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      pseudonymize: [{ field: 'name', type: 'custom', value: 'Redacted' }]
    });
  });

  test('reads a flattened "group" alongside the type', () => {
    const entityDef = {
      elements: {
        syd: {
          type: 'cds.String',
          '@mcp.policy.pseudonymize.type': 'opaque',
          '@mcp.policy.pseudonymize.group': 'surname'
        }
      }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      pseudonymize: [{ field: 'syd', type: 'opaque', group: 'surname' }]
    });
  });

  test('a bare @mcp.policy.pseudonymize (compiled to true) means pseudonymize with the default type', () => {
    const entityDef = { elements: { email: { type: 'cds.String', '@mcp.policy.pseudonymize': true } } };
    expect(readEntityAnnotations(entityDef)).toEqual({ pseudonymize: [{ field: 'email' }] });
  });

  test('still accepts a genuinely nested object, which CDS does not emit today', () => {
    const entityDef = {
      elements: { name: { type: 'cds.String', '@mcp.policy.pseudonymize': { type: 'custom', value: 'Redacted' } } }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      pseudonymize: [{ field: 'name', type: 'custom', value: 'Redacted' }]
    });
  });

  test('carries a pseudonymize "group" through from a nested annotation object', () => {
    const entityDef = {
      elements: { syd: { type: 'cds.String', '@mcp.policy.pseudonymize': { type: 'opaque', group: 'surname' } } }
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      pseudonymize: [{ field: 'syd', type: 'opaque', group: 'surname' }]
    });
  });

  test('reads entity-level maxRows and allowTools', () => {
    const entityDef = { elements: {}, '@mcp.policy.maxRows': 50, '@mcp.policy.allowTools': ['ReadOrders'] };
    expect(readEntityAnnotations(entityDef)).toEqual({ maxRows: 50, allowTools: ['ReadOrders'] });
  });

  test('combines mask, pseudonymize, maxRows and allowTools together', () => {
    const entityDef = {
      elements: {
        salary: { '@mcp.policy.mask': true },
        iban: { '@mcp.policy.pseudonymize': 'iban' }
      },
      '@mcp.policy.maxRows': 10
    };
    expect(readEntityAnnotations(entityDef)).toEqual({
      mask: ['salary'],
      pseudonymize: [{ field: 'iban', type: 'iban' }],
      maxRows: 10
    });
  });
});

describe('scanAnnotations', () => {
  test('is a no-op when cds/services/entities are missing (duck-typed test fakes)', () => {
    expect(scanAnnotations(undefined)).toEqual({});
    expect(scanAnnotations({})).toEqual({});
    expect(scanAnnotations({ services: { Orders: {} } })).toEqual({});
  });

  test('keys the result by the entity\'s fully-qualified name when available', () => {
    const cds = {
      services: {
        CatalogService: {
          entities: {
            Employees: { name: 'CatalogService.Employees', elements: { salary: { '@mcp.policy.mask': true } } }
          }
        }
      }
    };
    expect(scanAnnotations(cds)).toEqual({ 'CatalogService.Employees': { mask: ['salary'] } });
  });

  test('falls back to the dictionary key when the entity has no .name', () => {
    const cds = {
      services: { Orders: { entities: { Orders: { elements: { CreditCard: { '@mcp.policy.mask': true } } } } } }
    };
    expect(scanAnnotations(cds)).toEqual({ Orders: { mask: ['CreditCard'] } });
  });

  test('omits entities that carry no @mcp.policy annotations, scanning across multiple services', () => {
    const cds = {
      services: {
        CatalogService: {
          entities: {
            Employees: { name: 'CatalogService.Employees', elements: { salary: { '@mcp.policy.mask': true } } },
            Departments: { name: 'CatalogService.Departments', elements: { ID: { type: 'cds.Integer' } } }
          }
        },
        HealthService: { entities: {} }
      }
    };
    expect(scanAnnotations(cds)).toEqual({ 'CatalogService.Employees': { mask: ['salary'] } });
  });
});

describe('mergeEntityConfig', () => {
  test('returns the other side unchanged when one side is absent', () => {
    const jsonConfig = { mask: ['budget'] };
    expect(mergeEntityConfig('Departments', undefined, jsonConfig)).toBe(jsonConfig);

    const annotationConfig = { mask: ['salary'] };
    expect(mergeEntityConfig('Employees', annotationConfig, undefined)).toBe(annotationConfig);
  });

  test('unions mask fields from both sides, deduplicated', () => {
    const merged = mergeEntityConfig('Employees', { mask: ['salary'] }, { mask: ['salary', 'nationalId'] });
    expect(merged.mask.sort()).toEqual(['nationalId', 'salary']);
  });

  test('unions pseudonymize entries by field; the package.json entry wins on the same field', () => {
    const merged = mergeEntityConfig(
      'Employees',
      { pseudonymize: [{ field: 'iban', type: 'opaque' }] },
      { pseudonymize: [{ field: 'iban', type: 'iban' }, { field: 'name', type: 'custom', value: 'Redacted' }] }
    );
    expect(merged.pseudonymize).toEqual([
      { field: 'iban', type: 'iban' },
      { field: 'name', type: 'custom', value: 'Redacted' }
    ]);
  });

  test('package.json maxRows/allowTools win over the annotation ones when both are set', () => {
    const merged = mergeEntityConfig(
      'Orders',
      { maxRows: 500, allowTools: ['FromAnnotation'] },
      { maxRows: 10, allowTools: ['FromJson'] }
    );
    expect(merged.maxRows).toBe(10);
    expect(merged.allowTools).toEqual(['FromJson']);
  });

  test('falls back to the annotation maxRows/allowTools when package.json does not set them', () => {
    const merged = mergeEntityConfig('Orders', { maxRows: 500, allowTools: ['FromAnnotation'] }, { mask: ['x'] });
    expect(merged.maxRows).toBe(500);
    expect(merged.allowTools).toEqual(['FromAnnotation']);
  });

  test('unions mask rules from both sides; the package.json rule wins on the same field', () => {
    const merged = mergeEntityConfig(
      'Employees',
      { mask: ['iban', 'email'], maskRules: { iban: { type: 'partial', keepLeft: 4 }, email: { type: 'email' } } },
      { mask: ['iban'], maskRules: { iban: { type: 'partial', keepLeft: 2, keepRight: 2 } } }
    );

    expect(merged.mask.sort()).toEqual(['email', 'iban']);
    expect(merged.maskRules).toEqual({
      iban: { type: 'partial', keepLeft: 2, keepRight: 2 },
      email: { type: 'email' }
    });
  });

  test('no maskRules key at all when neither side has one, so an existing config is byte-identical', () => {
    const merged = mergeEntityConfig('Employees', { mask: ['salary'] }, { mask: ['nationalId'] });
    expect(merged).not.toHaveProperty('maskRules');
  });

  test('throws when the merged result would list the same field under both mask and pseudonymize', () => {
    expect(() =>
      mergeEntityConfig('Employees', { mask: ['salary'] }, { pseudonymize: [{ field: 'salary', type: 'opaque' }] })
    ).toThrow(/"salary" cannot be listed in both "mask" and "pseudonymize"/);
  });
});

describe('mergeAnnotationsIntoPolicy', () => {
  test('adds an annotation-only entity to a policyDefinition that never mentioned it', () => {
    const cds = {
      services: {
        CatalogService: {
          entities: { Employees: { name: 'CatalogService.Employees', elements: { salary: { '@mcp.policy.mask': true } } } }
        }
      }
    };
    const policyDefinition = { mode: 'enforce', entities: {} };

    const result = mergeAnnotationsIntoPolicy(cds, policyDefinition, validateEntityConfig);

    expect(result.mode).toBe('enforce');
    expect(result.entities).toEqual({ 'CatalogService.Employees': { mask: ['salary'] } });
  });

  test('merges into an entity that package.json already configures, leaving other entities untouched', () => {
    const cds = {
      services: {
        CatalogService: {
          entities: {
            Employees: { name: 'CatalogService.Employees', elements: { nationalId: { '@mcp.policy.mask': true } } }
          }
        }
      }
    };
    const policyDefinition = {
      mode: 'enforce',
      entities: {
        'CatalogService.Employees': { mask: ['salary'] },
        'CatalogService.Departments': { mask: ['budget'] }
      }
    };

    const result = mergeAnnotationsIntoPolicy(cds, policyDefinition, validateEntityConfig);

    expect(result.entities['CatalogService.Employees'].mask.sort()).toEqual(['nationalId', 'salary']);
    expect(result.entities['CatalogService.Departments']).toEqual({ mask: ['budget'] });
  });

  test('leaves mode/services/users/audit untouched', () => {
    const cds = { services: {} };
    const policyDefinition = { mode: 'observe', entities: {}, services: ['AgentCatalogService'], users: ['mcp-agent'], audit: { stdout: false } };

    const result = mergeAnnotationsIntoPolicy(cds, policyDefinition, validateEntityConfig);

    expect(result.mode).toBe('observe');
    expect(result.services).toEqual(['AgentCatalogService']);
    expect(result.users).toEqual(['mcp-agent']);
    expect(result.audit).toEqual({ stdout: false });
  });

  test('propagates validation errors from an invalid annotation (e.g. an unknown pseudonymize type)', () => {
    const cds = {
      services: {
        CatalogService: {
          entities: {
            Employees: { name: 'CatalogService.Employees', elements: { iban: { '@mcp.policy.pseudonymize': 'not-a-real-type' } } }
          }
        }
      }
    };
    const policyDefinition = { mode: 'enforce', entities: {} };

    expect(() => mergeAnnotationsIntoPolicy(cds, policyDefinition, validateEntityConfig)).toThrow(/pseudonymize.*type must be one of/);
  });
});
