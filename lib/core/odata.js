'use strict';

const { resolveEntityForPath, resolveExpandTarget } = require('./edm');

const ODATA_SYSTEM_SEGMENTS = new Set(['$metadata', '$batch']);

const METHOD_TO_OPERATION = {
  GET: 'READ',
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  MERGE: 'UPDATE',
  DELETE: 'DELETE'
};

/**
 * Resolves the OData entity-set (or navigation property) name a request
 * targets, from its URL path alone — no service metadata ($metadata/CSDL)
 * is consulted. Works for both OData V2 (`/sap/opu/odata/sap/ZGW_SRV/Products`)
 * and V4 (`/odata/v4/browse/Books(201)`) path conventions: it's the last
 * path segment, with any `(key)` predicate stripped.
 *
 * Returns undefined for OData system resources ($metadata, $batch) since
 * those don't map to a single configurable entity.
 *
 * Pure function, no HTTP framework dependency.
 *
 * @param {string} url request path or full URL (query string is ignored)
 * @returns {string|undefined}
 */
function resolveEntitySet(url) {
  if (!url) return undefined;

  const pathOnly = url.split('?')[0];
  const segments = pathOnly.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;

  const last = segments[segments.length - 1].replace(/\(.*$/, '');
  if (!last || ODATA_SYSTEM_SEGMENTS.has(last) || last.startsWith('$')) return undefined;

  return last;
}

/**
 * Maps an HTTP method onto the same CQN-style operation vocabulary the
 * guard already uses for CAP requests (READ/CREATE/UPDATE/DELETE, see
 * lib/adapters/cap.js's resolveOperation) — so one cap-mcp-guard.yaml
 * applies unchanged whether traffic arrives via CAP's before/after hooks
 * or raw OData HTTP.
 *
 * @param {string} method
 * @returns {string|undefined}
 */
function resolveOperation(method) {
  return METHOD_TO_OPERATION[(method || '').toUpperCase()];
}

/**
 * @param {string} url
 * @returns {boolean} true for a $batch request (OData V2 and V4 both use
 *   this convention). Its body is a multipart mix of sub-requests this
 *   module does not decode, so per-entity masking does not reach inside it
 *   — see README "Limitations".
 */
function isBatchRequest(url) {
  if (!url) return false;
  const pathOnly = url.split('?')[0];
  return pathOnly.split('/').filter(Boolean).pop() === '$batch';
}

/**
 * Extracts the row objects an OData JSON response body carries, regardless
 * of whether it's a V2 collection (`{ d: { results: [...] } }`), a V2
 * single entity (`{ d: {...} }`), a V4 collection (`{ value: [...] }`), or
 * a V4 single entity (a bare entity object carrying `@odata.context`).
 *
 * The returned rows are the SAME object references found inside `body` —
 * mutating a returned row mutates the response body in place, mirroring
 * how CAP's `after` handlers mutate results in place (see
 * lib/core/interceptor.js's applyMask).
 *
 * @param {*} body parsed JSON response body
 * @returns {object[]} row objects (empty array if the shape is unrecognized)
 */
function extractResultRows(body) {
  if (!body || typeof body !== 'object') return [];

  if (Array.isArray(body.value)) return body.value;
  if (body.d && Array.isArray(body.d.results)) return body.d.results;
  if (body.d && typeof body.d === 'object') return [body.d];
  if ('@odata.context' in body) return [body];

  return [];
}

/**
 * Resolves the FULL request path (every segment, not just the last) into
 * a policy-config-friendly entity name. Without `edm`, this is exactly
 * resolveEntitySet()'s single-last-segment heuristic — unchanged behavior.
 * With `edm` (see lib/core/edm.js's parseMetadata()), the whole path is
 * walked hop-by-hop through navigation properties, so a deep path like
 * `Books(201)/author` resolves to `author`'s real target entity instead
 * of the literal string `"author"`.
 *
 * @param {string} url
 * @param {object} [edm] see lib/core/edm.js parseMetadata()
 * @returns {string|undefined}
 */
function resolveEntityPath(url, edm) {
  if (!edm) return resolveEntitySet(url);
  if (!url) return undefined;

  const pathOnly = url.split('?')[0];
  const segments = pathOnly
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/\(.*$/, ''))
    .filter((s) => s && !ODATA_SYSTEM_SEGMENTS.has(s) && !s.startsWith('$'));

  return resolveEntityForPath(edm, segments);
}

function nestedRowsFor(row, navName) {
  const value = row && typeof row === 'object' ? row[navName] : undefined;

  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results; // OData V2 expand shape
  if (value && typeof value === 'object' && !('__deferred' in value)) return [value];

  return [];
}

/**
 * Walks a parsed OData response body and groups every row it contains —
 * the top-level collection/entity plus every `$expand`'ed nested
 * entity/collection reachable through `expandTree` — by the entity name
 * masking rules should be looked up under. Each group's rows are the SAME
 * object references found inside `body` (see extractResultRows), so
 * masking a group's rows mutates the response body in place.
 *
 * Without an `edm`, a nested entity's name is just its nav-property name
 * as it appears in `$expand` — good enough when cap-mcp-guard.yaml happens
 * to key an entity by that same name, but not a real entity-set/type
 * resolution. Pass `edm` (see lib/core/edm.js) to resolve nav properties
 * to their real target entity instead.
 *
 * @param {*} body parsed JSON response body
 * @param {string} rootEntity entity name for the top-level rows
 * @param {object} [expandTree] see lib/core/edm.js parseExpandOption()
 * @param {object} [edm] see lib/core/edm.js parseMetadata()
 * @returns {{ entity: string, rows: object[] }[]}
 */
function collectMaskableGroups(body, rootEntity, expandTree = {}, edm) {
  const groups = [];

  function walk(rows, entityName, tree) {
    if (rows.length) groups.push({ entity: entityName, rows });

    for (const [navName, subTree] of Object.entries(tree)) {
      const nestedEntity = edm ? resolveExpandTarget(edm, entityName, navName) : navName;
      const nestedRows = rows.flatMap((row) => nestedRowsFor(row, navName));

      walk(nestedRows, nestedEntity, subTree);
    }
  }

  walk(extractResultRows(body), rootEntity, expandTree);
  return groups;
}

module.exports = {
  resolveEntitySet,
  resolveOperation,
  isBatchRequest,
  extractResultRows,
  resolveEntityPath,
  collectMaskableGroups
};
