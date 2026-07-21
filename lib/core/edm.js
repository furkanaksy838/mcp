'use strict';

/**
 * A hand-rolled, regex-based reader for OData `$metadata` documents (EDMX/
 * CSDL XML, V2 or V4) — not a general-purpose XML/EDM implementation, just
 * enough structure (entity sets, entity types, navigation properties) to
 * resolve a URL path or a `$expand` nav-property name down to the entity
 * name cap-mcp-guard.yaml keys entities by. Good enough for the
 * well-formed $metadata documents SAP/CAP services actually emit.
 *
 * Pure — no I/O. Fetching `$metadata` over the network is the caller's
 * responsibility (see lib/adapters/odata.js's `metadataXml`/`edm` options);
 * keeping that out of this module means it stays synchronous and
 * dependency-free.
 */

function matchAll(pattern, text) {
  const results = [];
  const re = new RegExp(pattern, 'g');
  let m;
  while ((m = re.exec(text))) results.push(m);
  return results;
}

function getAttr(tagAttrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tagAttrs);
  return m ? m[1] : undefined;
}

function unwrapCollection(type) {
  const m = /^Collection\(([^)]+)\)$/.exec(type || '');
  return m ? { target: m[1], isCollection: true } : { target: type, isCollection: false };
}

function unqualifiedName(fqName) {
  if (!fqName) return fqName;
  const idx = fqName.lastIndexOf('.');
  return idx === -1 ? fqName : fqName.slice(idx + 1);
}

/**
 * Parses an EDMX/CSDL XML string into a minimal EDM model.
 *
 * @param {string} xml
 * @returns {{
 *   entityTypes: Record<string, { navigationProperties: Record<string, { target: string, isCollection?: boolean }> }>,
 *   entitySets: Record<string, string>,
 *   entityTypeToSet: Record<string, string>
 * }}
 */
function parseMetadata(xml) {
  const entityTypes = {};
  const entitySets = {};
  const entityTypeToSet = {};

  const schemaBlocks = matchAll('<Schema\\b([^>]*)>([\\s\\S]*?)</Schema>', xml);

  for (const schemaMatch of schemaBlocks) {
    const namespace = getAttr(schemaMatch[1], 'Namespace');
    const schemaBody = schemaMatch[2];
    if (!namespace) continue;

    // V2 only: NavigationProperty indirects through Relationship/ToRole to
    // an <Association>'s <End Role="..." Type="...">. V4 NavigationProperty
    // carries its target Type directly, no association needed.
    const associations = {};
    for (const assocMatch of matchAll('<Association\\b[^>]*Name="([^"]*)"[^>]*>([\\s\\S]*?)</Association>', schemaBody)) {
      const fqName = `${namespace}.${assocMatch[1]}`;
      const roles = {};
      for (const endMatch of matchAll('<End\\b([^>]*?)/?>', assocMatch[2])) {
        const role = getAttr(endMatch[1], 'Role');
        const type = getAttr(endMatch[1], 'Type');
        if (role && type) roles[role] = type;
      }
      associations[fqName] = roles;
    }

    for (const entityTypeMatch of matchAll('<EntityType\\b([^>]*)>([\\s\\S]*?)</EntityType>', schemaBody)) {
      const localName = getAttr(entityTypeMatch[1], 'Name');
      if (!localName) continue;
      const fqName = `${namespace}.${localName}`;
      const body = entityTypeMatch[2];

      const navigationProperties = {};
      for (const navMatch of matchAll('<NavigationProperty\\b([^>]*?)/?>', body)) {
        const attrs = navMatch[1];
        const navName = getAttr(attrs, 'Name');
        if (!navName) continue;

        const typeAttr = getAttr(attrs, 'Type');
        if (typeAttr) {
          navigationProperties[navName] = unwrapCollection(typeAttr);
          continue;
        }

        const relationship = getAttr(attrs, 'Relationship');
        const toRole = getAttr(attrs, 'ToRole');
        const target = relationship && toRole && associations[relationship] && associations[relationship][toRole];
        if (target) {
          navigationProperties[navName] = { target, isCollection: undefined };
        }
      }

      entityTypes[fqName] = { navigationProperties };
    }

    for (const setMatch of matchAll('<EntitySet\\b([^>]*?)/?>', schemaBody)) {
      const attrs = setMatch[1];
      const setName = getAttr(attrs, 'Name');
      const entityType = getAttr(attrs, 'EntityType');
      if (!setName || !entityType) continue;

      entitySets[setName] = entityType;
      if (!entityTypeToSet[entityType]) entityTypeToSet[entityType] = setName;
    }
  }

  return { entityTypes, entitySets, entityTypeToSet };
}

/** An entity set name when one maps to this type, else its bare local name. */
function toDisplayName(edm, fqTypeName) {
  return (edm.entityTypeToSet && edm.entityTypeToSet[fqTypeName]) || unqualifiedName(fqTypeName);
}

/**
 * Resolves already-split, already-`(key)`-stripped, $-segment-free URL path
 * segments against a parsed EDM, walking navigation properties hop by hop
 * from the first segment that matches a known entity set (segments before
 * that — a service mount path like `odata/v4/browse` — are ignored, so
 * this works regardless of where the service is mounted).
 *
 * Falls back to the last path segment (matching lib/core/odata.js's
 * no-metadata resolveEntitySet() heuristic) when no segment matches a
 * known entity set, and to the raw segment name at any hop whose nav
 * property isn't described in the EDM — a `$metadata` document that
 * doesn't fully describe every segment shouldn't break resolution for the
 * segments it DOES know about.
 *
 * @param {object} edm see parseMetadata()
 * @param {string[]} segments
 * @returns {string|undefined}
 */
function resolveEntityForPath(edm, segments) {
  if (!segments.length) return undefined;

  const startIndex = segments.findIndex((s) => Object.prototype.hasOwnProperty.call(edm.entitySets, s));
  if (startIndex === -1) return segments[segments.length - 1];

  let currentType = edm.entitySets[segments[startIndex]];
  let displayName = toDisplayName(edm, currentType);

  for (let i = startIndex + 1; i < segments.length; i++) {
    const entityType = currentType && edm.entityTypes[currentType];
    const nav = entityType && entityType.navigationProperties[segments[i]];

    if (!nav) {
      displayName = segments[i];
      currentType = undefined;
      continue;
    }

    currentType = nav.target;
    displayName = toDisplayName(edm, currentType);
  }

  return displayName;
}

/**
 * Resolves a `$expand`'ed navigation-property name to its target entity's
 * policy-config-friendly name, given the (already-resolved) entity name of
 * the row it hangs off of. Falls back to the raw nav-property name when
 * the parent entity or the nav property itself isn't described in the EDM.
 *
 * @param {object} edm
 * @param {string} parentEntityName as returned by resolveEntityForPath() or
 *   a previous resolveExpandTarget() call
 * @param {string} navPropName
 * @returns {string}
 */
function resolveExpandTarget(edm, parentEntityName, navPropName) {
  const parentType =
    edm.entitySets[parentEntityName] ||
    Object.keys(edm.entityTypes).find((fq) => toDisplayName(edm, fq) === parentEntityName);

  const entityType = parentType && edm.entityTypes[parentType];
  const nav = entityType && entityType.navigationProperties[navPropName];

  return nav ? toDisplayName(edm, nav.target) : navPropName;
}

/**
 * Parses an OData `$expand` query-option value into a tree of nav-property
 * names to recurse into — e.g. `"author,genre($expand=parent)"` becomes
 * `{ author: {}, genre: { parent: {} } }`. Only a nested `$expand=` option
 * is honored inside a parenthesized nav property; other nested options
 * (`$select`, `$filter`, ...) don't change which nested entities show up
 * in the response body, so they're ignored.
 *
 * @param {string} expandParam raw (already URL-decoded) $expand value
 * @returns {object} nested tree, `{}` for an empty/missing value
 */
function parseExpandOption(expandParam) {
  const tree = {};
  if (!expandParam) return tree;

  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expandParam.length; i++) {
    const ch = expandParam[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(expandParam.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expandParam.slice(start));

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    const parenIdx = part.indexOf('(');
    if (parenIdx === -1) {
      tree[part] = tree[part] || {};
      continue;
    }

    const navName = part.slice(0, parenIdx).trim();
    const inner = part.slice(parenIdx + 1, part.lastIndexOf(')'));
    const nestedExpandMatch = /\$expand=([^;]*)/.exec(inner);
    tree[navName] = parseExpandOption(nestedExpandMatch ? nestedExpandMatch[1] : '');
  }

  return tree;
}

module.exports = { parseMetadata, resolveEntityForPath, resolveExpandTarget, parseExpandOption };
