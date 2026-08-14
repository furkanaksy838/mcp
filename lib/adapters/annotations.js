'use strict';

const ANNOTATION_PREFIX = '@mcp.policy.';
const PSEUDONYMIZE_KEY = `${ANNOTATION_PREFIX}pseudonymize`;
const MASK_KEY = `${ANNOTATION_PREFIX}mask`;

/**
 * Collects the flattened sub-keys of one annotation into an object, or undefined when the element
 * carries none. CDS stores `@x: {a: 1, b: 2}` as '@x.a' and '@x.b' rather than as a nested object,
 * so anything reading only the unsuffixed key sees nothing at all.
 */
function readFlattenedAnnotation(element, key) {
  const collected = {};
  for (const [k, value] of Object.entries(element)) {
    if (k.startsWith(`${key}.`)) collected[k.slice(key.length + 1)] = value;
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

/**
 * Reads one element's `@mcp.policy.mask` annotation.
 *
 * Two shapes, matching what config.js accepts for a `"mask"` entry:
 *   - `@mcp.policy.mask` on its own (compiled to `true`) — the placeholder, as before
 *   - `@mcp.policy.mask: {type: 'partial', keepLeft: 4, keepRight: 4}` — a strategy, which arrives
 *     as flattened dotted keys and so needs the same treatment as pseudonymize
 *
 * @returns {string|object|undefined} the field name for a plain mask, an entry object for a
 *   strategy, or undefined when the element isn't masked at all
 */
function readMaskAnnotation(element, field) {
  const flattened = readFlattenedAnnotation(element, MASK_KEY);
  if (flattened) return { field, ...flattened };

  const direct = element[MASK_KEY];
  if (direct === true) return field;
  // Defensive: current CDS flattens, but a duck-typed caller (or a compiler that stops flattening)
  // can still hand over a nested object.
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { field, ...direct };

  return undefined;
}

/**
 * Reads one element's `@mcp.policy.pseudonymize` annotation into a raw pseudonymize entry,
 * or undefined when the element doesn't carry one.
 *
 * The awkward part is that CDS *flattens* object-valued annotations into dotted keys rather
 * than storing a nested object, so
 *
 *   iban : String @mcp.policy.pseudonymize: { type: 'opaque', group: 'surname' };
 *
 * arrives on the compiled element as two separate keys — '@mcp.policy.pseudonymize.type' and
 * '@mcp.policy.pseudonymize.group' — and never as `element['@mcp.policy.pseudonymize']`. Any
 * reader that only looks at the unsuffixed key sees nothing at all and silently leaves the
 * field unprotected, which is exactly what happened before this function existed.
 *
 * The three shapes handled, in the order they're checked:
 *   - flattened keys (what CDS actually produces for the object form)
 *   - a bare string naming the type: `@mcp.policy.pseudonymize: 'iban'`
 *   - a bare annotation with no value at all, which CDS compiles to `true`, treated as "use
 *     the default type" rather than ignored — writing it is plainly a request to pseudonymize
 *   - a genuinely nested object, which current CDS doesn't emit, kept so a duck-typed caller
 *     (or a future compiler that stops flattening) still works
 */
function readPseudonymizeAnnotation(element, field) {
  const flattened = readFlattenedAnnotation(element, PSEUDONYMIZE_KEY);
  if (flattened) return { field, ...flattened };

  const direct = element[PSEUDONYMIZE_KEY];
  if (typeof direct === 'string') return { field, type: direct };
  if (direct === true) return { field };
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { field, ...direct };

  return undefined;
}

/**
 * Reads @mcp.policy.* annotations off one entity's compiled CSN definition into a raw
 * entity-config shape — the same shape lib/policy/config.js's validateEntityConfig()
 * already accepts from package.json, so annotation-sourced and package.json-sourced
 * config run through the exact same validation rules, not a parallel set of them.
 *
 * `mask` and `pseudonymize` each have several shapes and their own reader — see
 * readMaskAnnotation() and readPseudonymizeAnnotation().
 *
 * @param {object} entityDef a served service's compiled entity definition (srv.entities[x])
 * @returns {{mask?: string[], pseudonymize?: object[], maxRows?: number, allowTools?: string[]}|undefined}
 *   undefined when the entity carries no @mcp.policy annotations at all
 */
function readEntityAnnotations(entityDef) {
  if (!entityDef) return undefined;

  const mask = [];
  const pseudonymize = [];

  for (const [field, element] of Object.entries(entityDef.elements || {})) {
    if (!element) continue;

    const maskEntry = readMaskAnnotation(element, field);
    if (maskEntry !== undefined) {
      mask.push(maskEntry);
    }

    const pseudo = readPseudonymizeAnnotation(element, field);
    if (pseudo) {
      pseudonymize.push(pseudo);
    }
  }

  const maxRows = entityDef[`${ANNOTATION_PREFIX}maxRows`];
  const allowTools = entityDef[`${ANNOTATION_PREFIX}allowTools`];

  const hasAnything = mask.length > 0 || pseudonymize.length > 0 || maxRows !== undefined || allowTools !== undefined;
  if (!hasAnything) return undefined;

  return {
    ...(mask.length > 0 && { mask }),
    ...(pseudonymize.length > 0 && { pseudonymize }),
    ...(maxRows !== undefined && { maxRows }),
    ...(allowTools !== undefined && { allowTools })
  };
}

/**
 * Scans every served ApplicationService's entities for @mcp.policy annotations into a raw
 * {entityName: rawEntityConfig} map, keyed by each entity's fully-qualified name (matching
 * what req.target.name resolves to at request time — see interceptor.js#resolveEntity).
 * Entities without any @mcp.policy annotation are omitted. Defensive against services or
 * entities that don't look like real CAP objects (e.g. duck-typed fakes in tests, or a
 * service with no `.entities` at all) — a project with no annotations is simply a no-op.
 *
 * @param {object} cds the @sap/cds module (or compatible facade), read only for cds.services
 * @returns {object} raw entities map, the same shape parseConfig() expects under "entities"
 */
function scanAnnotations(cds) {
  const entities = {};
  for (const srv of Object.values((cds && cds.services) || {})) {
    for (const [name, entityDef] of Object.entries((srv && srv.entities) || {})) {
      const raw = readEntityAnnotations(entityDef);
      if (!raw) continue;
      const key = (entityDef && entityDef.name) || name;
      entities[key] = raw;
    }
  }
  return entities;
}

/**
 * Merges one entity's annotation-derived config with its package.json-derived config
 * (either side may be absent). mask fields union (deduplicated); pseudonymize entries
 * union by field, with the package.json entry winning when the same field is pseudonymized
 * from both sources; maxRows/allowTools prefer the package.json value when both set. Throws
 * if the merged result lists the same field under both mask and pseudonymize — the same
 * conflict validateEntityConfig() already rejects within a single source, now checked
 * across both.
 *
 * @param {string} name entity name, used only for the error message
 * @param {object|undefined} annotationConfig already-validated (via validateEntityConfig)
 * @param {object|undefined} jsonConfig already-validated (via validateEntityConfig)
 */
function mergeEntityConfig(name, annotationConfig, jsonConfig) {
  if (!annotationConfig) return jsonConfig;
  if (!jsonConfig) return annotationConfig;

  const mask = Array.from(new Set([...(annotationConfig.mask || []), ...(jsonConfig.mask || [])]));

  // Per-field mask strategies merge the same way pseudonymize entries do: union by field, with the
  // package.json rule winning, so a deployment can override a strategy the model declared without
  // editing the model.
  const maskRules = { ...(annotationConfig.maskRules || {}), ...(jsonConfig.maskRules || {}) };

  const pseudonymizeByField = new Map();
  for (const entry of annotationConfig.pseudonymize || []) pseudonymizeByField.set(entry.field, entry);
  for (const entry of jsonConfig.pseudonymize || []) pseudonymizeByField.set(entry.field, entry);
  const pseudonymize = Array.from(pseudonymizeByField.values());

  const maskedFields = new Set(mask);
  for (const { field } of pseudonymize) {
    if (maskedFields.has(field)) {
      throw new Error(
        `entities.${name}: "${field}" cannot be listed in both "mask" and "pseudonymize" ` +
          '(combining @mcp.policy annotations with package.json config)'
      );
    }
  }

  return {
    ...(mask.length > 0 && { mask }),
    ...(Object.keys(maskRules).length > 0 && { maskRules }),
    ...(pseudonymize.length > 0 && { pseudonymize }),
    maxRows: jsonConfig.maxRows !== undefined ? jsonConfig.maxRows : annotationConfig.maxRows,
    allowTools: jsonConfig.allowTools !== undefined ? jsonConfig.allowTools : annotationConfig.allowTools
  };
}

/**
 * Builds the final PolicyDefinition for a boot by folding @mcp.policy CDS annotations
 * (discovered from the now-compiled, served model) into the package.json-sourced one.
 * Call only once services are actually served (cds.on('served', ...)) — before that,
 * srv.entities isn't populated yet. mode/services/users/audit always come from
 * policyDefinition (package.json) unchanged; only per-entity mask/pseudonymize/maxRows/
 * allowTools are affected.
 *
 * @param {object} cds the @sap/cds module (or compatible facade)
 * @param {object} policyDefinition the package.json/explicit-option PolicyDefinition
 * @param {(name: string, raw: object) => object} validateEntityConfig from lib/policy/config.js —
 *   injected rather than required directly, so this stays trivially testable with a stub
 * @returns {object} a new PolicyDefinition with annotation-derived entity config merged in
 */
function mergeAnnotationsIntoPolicy(cds, policyDefinition, validateEntityConfig) {
  const rawAnnotationEntities = scanAnnotations(cds);
  const entities = { ...policyDefinition.entities };

  for (const [name, raw] of Object.entries(rawAnnotationEntities)) {
    const annotationConfig = validateEntityConfig(name, raw);
    entities[name] = mergeEntityConfig(name, annotationConfig, entities[name]);
  }

  return { ...policyDefinition, entities };
}

module.exports = { scanAnnotations, readEntityAnnotations, mergeEntityConfig, mergeAnnotationsIntoPolicy, ANNOTATION_PREFIX };
