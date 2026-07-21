'use strict';

const {
  resolveEntitySet,
  resolveOperation,
  isBatchRequest,
  extractResultRows,
  resolveEntityPath,
  collectMaskableGroups
} = require('../../lib/core/odata');
const { parseMetadata } = require('../../lib/core/edm');

const V4_METADATA = `
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="CatalogService" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Books">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <NavigationProperty Name="author" Type="CatalogService.Authors" Nullable="false"/>
      </EntityType>
      <EntityType Name="Authors">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="Books" EntityType="CatalogService.Books"/>
        <EntitySet Name="Authors" EntityType="CatalogService.Authors"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

describe('resolveEntitySet', () => {
  test('resolves a V4-style collection path', () => {
    expect(resolveEntitySet('/odata/v4/browse/Books')).toBe('Books');
  });

  test('resolves a V4-style single-entity path, stripping the (key) predicate', () => {
    expect(resolveEntitySet('/odata/v4/browse/Books(201)')).toBe('Books');
  });

  test('resolves a V2-style deeply-mounted service path', () => {
    expect(resolveEntitySet('/sap/opu/odata/sap/ZGW_SRV/Products')).toBe('Products');
  });

  test('resolves a navigation-property segment as its own name', () => {
    expect(resolveEntitySet('/odata/v4/browse/Books(201)/author')).toBe('author');
  });

  test('ignores the query string', () => {
    expect(resolveEntitySet('/odata/v4/browse/Books?$select=title')).toBe('Books');
  });

  test('returns undefined for $metadata', () => {
    expect(resolveEntitySet('/odata/v4/browse/$metadata')).toBeUndefined();
  });

  test('returns undefined for $batch', () => {
    expect(resolveEntitySet('/odata/v4/browse/$batch')).toBeUndefined();
  });

  test('returns undefined for a missing or empty url', () => {
    expect(resolveEntitySet(undefined)).toBeUndefined();
    expect(resolveEntitySet('')).toBeUndefined();
    expect(resolveEntitySet('/')).toBeUndefined();
  });
});

describe('resolveOperation', () => {
  test.each([
    ['GET', 'READ'],
    ['get', 'READ'],
    ['POST', 'CREATE'],
    ['PUT', 'UPDATE'],
    ['PATCH', 'UPDATE'],
    ['MERGE', 'UPDATE'],
    ['DELETE', 'DELETE']
  ])('maps %s to %s', (method, operation) => {
    expect(resolveOperation(method)).toBe(operation);
  });

  test('returns undefined for an unrecognized or missing method', () => {
    expect(resolveOperation('TRACE')).toBeUndefined();
    expect(resolveOperation(undefined)).toBeUndefined();
  });
});

describe('isBatchRequest', () => {
  test('true for a $batch path', () => {
    expect(isBatchRequest('/odata/v4/browse/$batch')).toBe(true);
  });

  test('false for a regular entity-set path', () => {
    expect(isBatchRequest('/odata/v4/browse/Books')).toBe(false);
  });

  test('false for a missing url', () => {
    expect(isBatchRequest(undefined)).toBe(false);
  });
});

describe('extractResultRows', () => {
  test('extracts rows from a V4 collection response', () => {
    const body = { value: [{ ID: 1 }, { ID: 2 }] };
    expect(extractResultRows(body)).toBe(body.value);
  });

  test('extracts a single row from a V4 single-entity response', () => {
    const body = { '@odata.context': '$metadata#Books/$entity', ID: 1 };
    expect(extractResultRows(body)).toEqual([body]);
  });

  test('extracts rows from a V2 collection response', () => {
    const body = { d: { results: [{ ID: 1 }, { ID: 2 }] } };
    expect(extractResultRows(body)).toBe(body.d.results);
  });

  test('extracts a single row from a V2 single-entity response', () => {
    const body = { d: { ID: 1 } };
    expect(extractResultRows(body)).toEqual([body.d]);
  });

  test('returns an empty array for an unrecognized shape', () => {
    expect(extractResultRows({ error: { message: 'nope' } })).toEqual([]);
  });

  test('returns an empty array for null/undefined/non-object bodies', () => {
    expect(extractResultRows(null)).toEqual([]);
    expect(extractResultRows(undefined)).toEqual([]);
    expect(extractResultRows('plain text')).toEqual([]);
  });
});

describe('resolveEntityPath', () => {
  test('without an edm, behaves exactly like resolveEntitySet (last segment only)', () => {
    expect(resolveEntityPath('/odata/v4/browse/Books(201)/author')).toBe('author');
    expect(resolveEntityPath('/odata/v4/browse/Books')).toBe('Books');
  });

  test('with an edm, walks the full path through navigation properties', () => {
    const edm = parseMetadata(V4_METADATA);
    expect(resolveEntityPath('/odata/v4/browse/Books(201)/author', edm)).toBe('Authors');
    expect(resolveEntityPath('/odata/v4/browse/Books', edm)).toBe('Books');
  });

  test('returns undefined for a missing url regardless of edm', () => {
    const edm = parseMetadata(V4_METADATA);
    expect(resolveEntityPath(undefined, edm)).toBeUndefined();
  });
});

describe('collectMaskableGroups', () => {
  test('with no expandTree, returns just the root group (same as extractResultRows)', () => {
    const body = { value: [{ ID: 1 }, { ID: 2 }] };
    expect(collectMaskableGroups(body, 'Books')).toEqual([{ entity: 'Books', rows: body.value }]);
  });

  test('groups a $expand-ed nested collection under its nav-property name without an edm', () => {
    const author1 = { ID: 10, name: 'Bronte' };
    const book = { ID: 1, author: author1 };
    const body = { value: [book] };

    const groups = collectMaskableGroups(body, 'Books', { author: {} });

    expect(groups).toEqual([
      { entity: 'Books', rows: [book] },
      { entity: 'author', rows: [author1] }
    ]);
  });

  test('resolves the nested entity name via the edm when one is supplied', () => {
    const edm = parseMetadata(V4_METADATA);
    const author1 = { ID: 10, name: 'Bronte' };
    const book = { ID: 1, author: author1 };
    const body = { value: [book] };

    const groups = collectMaskableGroups(body, 'Books', { author: {} }, edm);

    expect(groups).toEqual([
      { entity: 'Books', rows: [book] },
      { entity: 'Authors', rows: [author1] }
    ]);
  });

  test('handles an OData V2 expand shape ({ results: [...] }) for a to-many nav property', () => {
    const books = [{ ID: 1 }, { ID: 2 }];
    const author = { ID: 10, name: 'Bronte', books: { results: books } };
    const body = { d: author };

    const groups = collectMaskableGroups(body, 'Authors', { books: {} });

    expect(groups).toEqual([
      { entity: 'Authors', rows: [author] },
      { entity: 'books', rows: books }
    ]);
  });

  test('recurses through a nested $expand tree two levels deep', () => {
    const parent = { ID: 100, name: 'Fiction' };
    const genre = { ID: 5, name: 'Classics', parent };
    const book = { ID: 1, genre };
    const body = { value: [book] };

    const groups = collectMaskableGroups(body, 'Books', { genre: { parent: {} } });

    expect(groups).toEqual([
      { entity: 'Books', rows: [book] },
      { entity: 'genre', rows: [genre] },
      { entity: 'parent', rows: [parent] }
    ]);
  });

  test('skips a nav property left un-expanded (an OData V2 __deferred stub)', () => {
    const book = { ID: 1, author: { __deferred: { uri: '...' } } };
    const body = { value: [book] };

    const groups = collectMaskableGroups(body, 'Books', { author: {} });

    expect(groups).toEqual([{ entity: 'Books', rows: [book] }]);
  });

  test('drops a group with zero rows (e.g. a null to-one expand)', () => {
    const book = { ID: 1, author: null };
    const body = { value: [book] };

    const groups = collectMaskableGroups(body, 'Books', { author: {} });

    expect(groups).toEqual([{ entity: 'Books', rows: [book] }]);
  });
});
