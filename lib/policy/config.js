'use strict';

const fs = require('fs');
const yaml = require('js-yaml');

const VALID_MODES = ['enforce', 'observe'];
const DEFAULT_SOURCE = 'cap-mcp-guard.yaml';

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function validateEntityConfig(name, raw) {
  const config = raw ?? {};

  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`entities.${name} must be a mapping, got ${typeOf(config)}`);
  }

  const { mask, maxRows, allowTools } = config;

  if (mask !== undefined && !Array.isArray(mask)) {
    throw new Error(`entities.${name}.mask must be an array, got ${typeOf(mask)}`);
  }

  if (allowTools !== undefined && !Array.isArray(allowTools)) {
    throw new Error(`entities.${name}.allowTools must be an array, got ${typeOf(allowTools)}`);
  }

  if (maxRows !== undefined) {
    if (typeof maxRows !== 'number' || Number.isNaN(maxRows)) {
      throw new Error(`entities.${name}.maxRows must be a number, got ${typeOf(maxRows)}`);
    }
    if (maxRows < 0) {
      throw new Error(`entities.${name}.maxRows must not be negative (got ${maxRows})`);
    }
  }

  return { mask, maxRows, allowTools };
}

/**
 * Parses and validates a cap-mcp-guard.yaml document (already read into a
 * string) into a PolicyDefinition — the source-agnostic shape the policy
 * engine consumes. Pure: no filesystem access.
 *
 * @param {string} yamlString
 * @param {object} [opts]
 * @param {string} [opts.source] label used in error messages (defaults to
 *   the conventional file name; loadConfig() passes the real path instead)
 * @returns {{ mode: 'enforce'|'observe', entities: object }}
 */
function parseConfig(yamlString, opts = {}) {
  const { source = DEFAULT_SOURCE } = opts;

  let doc;
  try {
    doc = yaml.load(yamlString);
  } catch (err) {
    throw new Error(`Failed to parse ${source}: ${err.message}`);
  }

  if (doc === undefined || doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source}: root must be a mapping with a "mode" key`);
  }

  if (!VALID_MODES.includes(doc.mode)) {
    throw new Error(`"mode" must be one of ${VALID_MODES.join(', ')} (got ${JSON.stringify(doc.mode)})`);
  }

  const rawEntities = doc.entities ?? {};
  if (typeof rawEntities !== 'object' || Array.isArray(rawEntities)) {
    throw new Error(`"entities" must be a mapping of entity name to config, got ${typeOf(rawEntities)}`);
  }

  const entities = {};
  for (const [name, raw] of Object.entries(rawEntities)) {
    entities[name] = validateEntityConfig(name, raw);
  }

  return { mode: doc.mode, entities };
}

/**
 * Reads cap-mcp-guard.yaml from disk and parses it via parseConfig().
 *
 * @param {string} path
 * @returns {{ mode: 'enforce'|'observe', entities: object }}
 */
function loadConfig(path) {
  let content;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`cap-mcp-guard.yaml not found at ${path}`);
    }
    throw err;
  }

  return parseConfig(content, { source: path });
}

module.exports = { loadConfig, parseConfig };