'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildAuditEntry, writeAuditEntry, logAudit } = require('../../lib/audit/log');

function context(overrides = {}) {
  return {
    'gen_ai.agent.id': 'agent-1',
    entity: 'Orders',
    operation: 'READ',
    rowCount: 3,
    timestamp: '2026-07-18T00:00:00.000Z',
    ...overrides
  };
}

function decision(overrides = {}) {
  return {
    mode: 'enforce',
    allowed: true,
    reason: null,
    fieldsToMask: ['CreditCard'],
    rowLimitExceeded: false,
    maxRows: null,
    entity: 'Orders',
    timestamp: '2026-07-18T00:00:00.000Z',
    ...overrides
  };
}

describe('buildAuditEntry', () => {
  test('nests the full context and decision under a top-level timestamp', () => {
    const ctx = context();
    const dec = decision();

    expect(buildAuditEntry(ctx, dec)).toEqual({
      timestamp: ctx.timestamp,
      context: ctx,
      decision: dec
    });
  });

  test('uses context.timestamp for the entry timestamp, even if decision.timestamp differs', () => {
    const entry = buildAuditEntry(context({ timestamp: 'CTX_TIME' }), decision({ timestamp: 'DEC_TIME' }));
    expect(entry.timestamp).toBe('CTX_TIME');
  });
});

describe('writeAuditEntry', () => {
  let tmpDir;
  let logSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-mcp-guard-audit-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  test('writes the entry as a single JSON line to stdout by default', () => {
    const entry = { timestamp: 't', context: {}, decision: {} };
    writeAuditEntry(entry);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(entry));
  });

  test('does not write to stdout when stdout: false', () => {
    writeAuditEntry({ timestamp: 't' }, { stdout: false });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('appends the entry as a JSON line to filePath when given', () => {
    const filePath = path.join(tmpDir, 'audit.log');
    const entry = { timestamp: 't1' };

    writeAuditEntry(entry, { filePath });
    writeAuditEntry({ timestamp: 't2' }, { filePath });

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toEqual([JSON.stringify({ timestamp: 't1' }), JSON.stringify({ timestamp: 't2' })]);
  });

  test('writes to both stdout and filePath when both are requested', () => {
    const filePath = path.join(tmpDir, 'audit.log');
    writeAuditEntry({ timestamp: 't' }, { filePath, stdout: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(`${JSON.stringify({ timestamp: 't' })}\n`);
  });
});

describe('logAudit', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('builds and writes the entry in one call, returning the entry', () => {
    const ctx = context();
    const dec = decision();

    const entry = logAudit(ctx, dec);

    expect(entry).toEqual({ timestamp: ctx.timestamp, context: ctx, decision: dec });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(entry));
  });
});