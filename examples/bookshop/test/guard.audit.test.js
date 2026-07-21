'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/..');

const { registerCapMcpGuard } = require('cap-mcp-guard/lib/adapters/cap');

describe('cap-mcp-guard M5 — audit log against the real bookshop service', () => {
  const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-bookshop-audit-')), 'audit.log');

  registerCapMcpGuard(cds, {
    policyDefinition: {
      mode: 'enforce',
      entities: { 'CatalogService.Books': { mask: ['price'] } }
    },
    audit: { filePath: auditFile, stdout: false }
  });

  it('appends one structured JSON line per request, with the full Context and Decision', async () => {
    await GET('/odata/v4/browse/Books');

    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line));
    const bookEntry = entries.find((e) => e.context.entity === 'CatalogService.Books');

    expect(bookEntry).toBeDefined();
    expect(bookEntry.timestamp).toBe(bookEntry.context.timestamp);
    expect(bookEntry.context.operation).toBe('READ');
    expect(typeof bookEntry.context.rowCount).toBe('number');
    expect(bookEntry.decision.mode).toBe('enforce');
    expect(bookEntry.decision.fieldsToMask).toEqual(['price']);
  });

  it('appends a new line for every subsequent request rather than overwriting', async () => {
    const before = fs.readFileSync(auditFile, 'utf8').trim().split('\n').length;
    await GET('/odata/v4/browse/Books');
    const after = fs.readFileSync(auditFile, 'utf8').trim().split('\n');

    expect(after.length).toBeGreaterThan(before);
  });
});