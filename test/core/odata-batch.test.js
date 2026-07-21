'use strict';

const {
  extractBoundary,
  splitMultipart,
  parseBatchRequests,
  parseBatchResponses,
  serializeBatchResponses
} = require('../../lib/core/odata-batch');

const REQUEST_BODY = [
  '--batch_123',
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'GET Books HTTP/1.1',
  'Accept: application/json',
  '',
  '--batch_123',
  'Content-Type: multipart/mixed; boundary=changeset_456',
  '',
  '--changeset_456',
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'POST Products HTTP/1.1',
  'Content-Type: application/json',
  '',
  '{"name":"Widget"}',
  '--changeset_456--',
  '--batch_123--'
].join('\r\n');

const RESPONSE_BODY = [
  '--batchresponse_789',
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'HTTP/1.1 200 OK',
  'Content-Type: application/json',
  '',
  '{"value":[{"ID":1,"price":9.99}]}',
  '--batchresponse_789',
  'Content-Type: multipart/mixed; boundary=changesetresponse_abc',
  '',
  '--changesetresponse_abc',
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'HTTP/1.1 201 Created',
  'Content-Type: application/json',
  '',
  '{"ID":5,"name":"Widget","cost":42}',
  '--changesetresponse_abc--',
  '--batchresponse_789--'
].join('\r\n');

describe('extractBoundary', () => {
  test('extracts an unquoted boundary', () => {
    expect(extractBoundary('multipart/mixed; boundary=batch_123')).toBe('batch_123');
  });

  test('extracts a quoted boundary', () => {
    expect(extractBoundary('multipart/mixed; boundary="batch_123"')).toBe('batch_123');
  });

  test('returns undefined when there is no boundary', () => {
    expect(extractBoundary('application/json')).toBeUndefined();
    expect(extractBoundary(undefined)).toBeUndefined();
  });
});

describe('splitMultipart', () => {
  test('splits top-level parts, dropping the preamble and closing marker', () => {
    const parts = splitMultipart(REQUEST_BODY, 'batch_123');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('GET Books HTTP/1.1');
    expect(parts[1]).toContain('multipart/mixed; boundary=changeset_456');
  });

  test('accepts a Buffer', () => {
    const parts = splitMultipart(Buffer.from(REQUEST_BODY, 'utf8'), 'batch_123');
    expect(parts).toHaveLength(2);
  });
});

describe('parseBatchRequests', () => {
  test('parses a single GET part and a nested changeset part', () => {
    const items = parseBatchRequests(REQUEST_BODY, 'batch_123');

    expect(items).toEqual([
      { kind: 'single', method: 'GET', url: 'Books', headerLines: ['Accept: application/json'], body: '' },
      {
        kind: 'changeset',
        boundary: 'changeset_456',
        parts: [
          {
            kind: 'single',
            method: 'POST',
            url: 'Products',
            headerLines: ['Content-Type: application/json'],
            body: '{"name":"Widget"}'
          }
        ]
      }
    ]);
  });
});

describe('parseBatchResponses', () => {
  test('parses a single 200 response and a nested changeset response', () => {
    const items = parseBatchResponses(RESPONSE_BODY, 'batchresponse_789');

    expect(items).toEqual([
      {
        kind: 'single',
        status: 200,
        statusText: 'OK',
        headerLines: ['Content-Type: application/json'],
        body: '{"value":[{"ID":1,"price":9.99}]}'
      },
      {
        kind: 'changeset',
        boundary: 'changesetresponse_abc',
        parts: [
          {
            kind: 'single',
            status: 201,
            statusText: 'Created',
            headerLines: ['Content-Type: application/json'],
            body: '{"ID":5,"name":"Widget","cost":42}'
          }
        ]
      }
    ]);
  });
});

describe('serializeBatchResponses', () => {
  test('round-trips: parse -> serialize -> re-parse yields an equivalent structure', () => {
    const items = parseBatchResponses(RESPONSE_BODY, 'batchresponse_789');
    const serialized = serializeBatchResponses(items, 'batchresponse_789');
    const reparsed = parseBatchResponses(serialized, 'batchresponse_789');

    expect(reparsed).toEqual(items);
  });

  test('reflects a mutation made to a parsed envelope body', () => {
    const items = parseBatchResponses(RESPONSE_BODY, 'batchresponse_789');
    items[0].body = '{"value":[{"ID":1,"price":"***MASKED***"}]}';
    items[1].parts[0].body = '{"ID":5,"name":"Widget","cost":"***MASKED***"}';

    const serialized = serializeBatchResponses(items, 'batchresponse_789');
    const reparsed = parseBatchResponses(serialized, 'batchresponse_789');

    expect(JSON.parse(reparsed[0].body)).toEqual({ value: [{ ID: 1, price: '***MASKED***' }] });
    expect(JSON.parse(reparsed[1].parts[0].body)).toEqual({ ID: 5, name: 'Widget', cost: '***MASKED***' });
  });
});
