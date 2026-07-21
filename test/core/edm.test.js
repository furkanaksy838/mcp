'use strict';

const { parseMetadata, resolveEntityForPath, resolveExpandTarget, parseExpandOption } = require('../../lib/core/edm');

const V4_METADATA = `
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="CatalogService" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Books">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="title" Type="Edm.String"/>
        <Property Name="price" Type="Edm.Decimal"/>
        <NavigationProperty Name="author" Type="CatalogService.Authors" Nullable="false"/>
      </EntityType>
      <EntityType Name="Authors">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="name" Type="Edm.String"/>
        <Property Name="dateOfDeath" Type="Edm.Date"/>
        <NavigationProperty Name="books" Type="Collection(CatalogService.Books)" Partner="author"/>
      </EntityType>
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="Books" EntityType="CatalogService.Books"/>
        <EntitySet Name="Authors" EntityType="CatalogService.Authors"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

const V2_METADATA = `
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices>
    <Schema Namespace="ZGW_SRV" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="cost" Type="Edm.Decimal"/>
        <NavigationProperty Name="toSupplier" Relationship="ZGW_SRV.Product_Supplier" FromRole="FromRole_Product_Supplier" ToRole="ToRole_Product_Supplier"/>
      </EntityType>
      <EntityType Name="Supplier">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="secretMargin" Type="Edm.Decimal"/>
      </EntityType>
      <Association Name="Product_Supplier">
        <End Role="FromRole_Product_Supplier" Type="ZGW_SRV.Product" Multiplicity="*"/>
        <End Role="ToRole_Product_Supplier" Type="ZGW_SRV.Supplier" Multiplicity="1"/>
      </Association>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="ZGW_SRV.Product"/>
        <EntitySet Name="Suppliers" EntityType="ZGW_SRV.Supplier"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

describe('parseMetadata (V4 CSDL)', () => {
  const edm = parseMetadata(V4_METADATA);

  test('extracts entity sets', () => {
    expect(edm.entitySets).toEqual({
      Books: 'CatalogService.Books',
      Authors: 'CatalogService.Authors'
    });
  });

  test('extracts navigation properties with their direct Type', () => {
    expect(edm.entityTypes['CatalogService.Books'].navigationProperties.author).toEqual({
      target: 'CatalogService.Authors',
      isCollection: false
    });
    expect(edm.entityTypes['CatalogService.Authors'].navigationProperties.books).toEqual({
      target: 'CatalogService.Books',
      isCollection: true
    });
  });
});

describe('parseMetadata (V2 EDMX with Associations)', () => {
  const edm = parseMetadata(V2_METADATA);

  test('extracts entity sets', () => {
    expect(edm.entitySets).toEqual({
      Products: 'ZGW_SRV.Product',
      Suppliers: 'ZGW_SRV.Supplier'
    });
  });

  test('resolves a navigation property through Relationship/ToRole to the Association End', () => {
    expect(edm.entityTypes['ZGW_SRV.Product'].navigationProperties.toSupplier).toEqual({
      target: 'ZGW_SRV.Supplier',
      isCollection: undefined
    });
  });
});

describe('resolveEntityForPath', () => {
  const v4Edm = parseMetadata(V4_METADATA);
  const v2Edm = parseMetadata(V2_METADATA);

  test('resolves a top-level entity set', () => {
    expect(resolveEntityForPath(v4Edm, ['Books'])).toBe('Books');
  });

  test('walks a V4 navigation property to its real target entity set', () => {
    expect(resolveEntityForPath(v4Edm, ['Books', 'author'])).toBe('Authors');
  });

  test('walks a V2 navigation property (via Association) to its real target entity set', () => {
    expect(resolveEntityForPath(v2Edm, ['Products', 'toSupplier'])).toBe('Suppliers');
  });

  test('ignores a service mount-path prefix that is not itself an entity set', () => {
    expect(resolveEntityForPath(v4Edm, ['odata', 'v4', 'browse', 'Books', 'author'])).toBe('Authors');
  });

  test('falls back to the last segment when nothing matches a known entity set', () => {
    expect(resolveEntityForPath(v4Edm, ['something', 'else'])).toBe('else');
  });

  test('falls back to the raw segment name when a nav property is unknown', () => {
    expect(resolveEntityForPath(v4Edm, ['Books', 'notARealNavProp'])).toBe('notARealNavProp');
  });
});

describe('resolveExpandTarget', () => {
  const v4Edm = parseMetadata(V4_METADATA);

  test('resolves a nav property name to its target entity set', () => {
    expect(resolveExpandTarget(v4Edm, 'Books', 'author')).toBe('Authors');
  });

  test('falls back to the raw nav property name when unresolvable', () => {
    expect(resolveExpandTarget(v4Edm, 'Books', 'unknownNav')).toBe('unknownNav');
    expect(resolveExpandTarget(v4Edm, 'UnknownEntity', 'author')).toBe('author');
  });
});

describe('parseExpandOption', () => {
  test('parses a single nav property', () => {
    expect(parseExpandOption('author')).toEqual({ author: {} });
  });

  test('parses a comma-separated list', () => {
    expect(parseExpandOption('author,genre')).toEqual({ author: {}, genre: {} });
  });

  test('parses a nested $expand inside parentheses', () => {
    expect(parseExpandOption('genre($expand=parent)')).toEqual({ genre: { parent: {} } });
  });

  test('ignores other nested options alongside a nested $expand', () => {
    expect(parseExpandOption('genre($select=name;$expand=parent)')).toEqual({ genre: { parent: {} } });
  });

  test('returns an empty tree for a missing value', () => {
    expect(parseExpandOption(undefined)).toEqual({});
    expect(parseExpandOption('')).toEqual({});
  });
});
