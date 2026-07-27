'use strict';

const fs = require('fs');

const VALID_MODES = ['enforce', 'observe'];
const CONFIG_KEY = 'cap-mcp-guard';
const NOT_CONFIGURED_PREFIX = 'cap-mcp-guard not configured';

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
 * Validates an already-parsed `"cap-mcp-guard"` config object (the value of
 * that key in package.json) into a PolicyDefinition — the source-agnostic
 * shape the policy engine consumes. Pure: no filesystem access.
 *
 * @param {object} raw the parsed `"cap-mcp-guard"` value
 * @param {object} [opts]
 * @param {string} [opts.source] label used in error messages (defaults to
 *   the conventional file name; loadConfig() passes the real path instead)
 * @returns {{ mode: 'enforce'|'observe', entities: object, services: (string[]|undefined), users: (string[]|undefined) }}
 */
function parseConfig(raw, opts = {}) {
  const { source = 'package.json' } = opts;

  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: "${CONFIG_KEY}" must be a mapping with a "mode" key`);
  }

  if (!VALID_MODES.includes(raw.mode)) {
    throw new Error(`"mode" must be one of ${VALID_MODES.join(', ')} (got ${JSON.stringify(raw.mode)})`);
  }

  const rawEntities = raw.entities ?? {};
  if (typeof rawEntities !== 'object' || Array.isArray(rawEntities)) {
    throw new Error(`"entities" must be a mapping of entity name to config, got ${typeOf(rawEntities)}`);
  }

  const entities = {};
  for (const [name, entityRaw] of Object.entries(rawEntities)) {
    entities[name] = validateEntityConfig(name, entityRaw);
  }

  if (raw.services !== undefined && !Array.isArray(raw.services)) {
    throw new Error(`"services" must be an array, got ${typeOf(raw.services)}`);
  }

  if (raw.users !== undefined && !Array.isArray(raw.users)) {
    throw new Error(`"users" must be an array, got ${typeOf(raw.users)}`);
  }

  return { mode: raw.mode, entities, services: raw.services, users: raw.users };
}

/**
 * Reads the host project's package.json and validates its `"cap-mcp-guard"`
 * key via parseConfig(). Both "no package.json at this path" and "package.json
 * exists but has no cap-mcp-guard key" are reported under the same
 * NOT_CONFIGURED_PREFIX, so callers can treat either as "not configured yet"
 * with a single startsWith() check and fall back to pass-through mode.
 *
 * @param {string} packageJsonPath
 * @returns {{ mode: 'enforce'|'observe', entities: object, services: (string[]|undefined), users: (string[]|undefined) }}
 */
function loadConfig(packageJsonPath) {
  let content;
  try {
    content = fs.readFileSync(packageJsonPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${NOT_CONFIGURED_PREFIX}: no package.json found at ${packageJsonPath}`);
    }
    throw err;
  }

  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse ${packageJsonPath}: ${err.message}`);
  }

  const raw = pkg[CONFIG_KEY];
  if (raw === undefined) {
    throw new Error(`${NOT_CONFIGURED_PREFIX}: "${CONFIG_KEY}" key not found in ${packageJsonPath}`);
  }

  return parseConfig(raw, { source: packageJsonPath });
}

module.exports = { loadConfig, parseConfig, NOT_CONFIGURED_PREFIX };
