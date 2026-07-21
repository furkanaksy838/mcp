'use strict';

const fs = require('fs');

/**
 * Builds the structured audit entry for a single request: the full guard
 * Context (lib/core/context.js) alongside the Decision computed for it
 * (lib/policy/evaluator.js). Pure — no I/O, no CAP dependency.
 *
 * @param {object} context
 * @param {object} decision
 * @returns {{ timestamp: string, context: object, decision: object }}
 */
function buildAuditEntry(context, decision) {
  return {
    timestamp: context.timestamp,
    context,
    decision
  };
}

/**
 * Writes an audit entry as a single line of JSON (one entry per line, so
 * log files stay grep/tail-friendly). Always writes to stdout unless
 * `stdout: false`; additionally appends to `filePath` if given. Plain
 * Node `fs` — no CAP dependency.
 *
 * @param {object} entry see buildAuditEntry()
 * @param {object} [options]
 * @param {boolean} [options.stdout] defaults to true
 * @param {string} [options.filePath] optional file to append the line to
 */
function writeAuditEntry(entry, options = {}) {
  const { stdout = true, filePath } = options;
  const line = JSON.stringify(entry);

  if (stdout) {
    console.log(line);
  }

  if (filePath) {
    fs.appendFileSync(filePath, line + '\n');
  }
}

/**
 * Convenience combining buildAuditEntry() + writeAuditEntry() — the
 * function lib/adapters/cap.js wires as the interceptor's onDecision
 * callback by default.
 *
 * @param {object} context
 * @param {object} decision
 * @param {object} [options] see writeAuditEntry()
 * @returns {object} the entry that was written
 */
function logAudit(context, decision, options = {}) {
  const entry = buildAuditEntry(context, decision);
  writeAuditEntry(entry, options);
  return entry;
}

module.exports = { buildAuditEntry, writeAuditEntry, logAudit };