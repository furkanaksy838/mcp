'use strict';

/**
 * A minimal reader/writer for the classic OData V2 `$batch` wire format:
 * a `multipart/mixed` body whose parts are either a single embedded HTTP
 * request/response (`Content-Type: application/http`) or a nested
 * `multipart/mixed` "changeset" grouping several write operations
 * atomically. Not a general-purpose MIME implementation — just enough
 * structure to zip a batch's requests to its responses by position and
 * mask each response's JSON body in place.
 *
 * Responses are re-serialized canonically (consistent CRLF line endings,
 * consistent header ordering per part) rather than byte-for-byte
 * preserved — that's syntactically equivalent multipart/mixed, which is
 * all any compliant OData client relies on; it does not reproduce the
 * exact original bytes.
 *
 * Pure — no I/O, no HTTP framework dependency.
 */

function toText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

/**
 * @param {string} contentType a Content-Type header value
 * @returns {string|undefined} the `boundary` parameter, unquoted
 */
function extractBoundary(contentType) {
  const m = /boundary=("?)([^;"]+)\1/i.exec(contentType || '');
  return m ? m[2] : undefined;
}

/** Splits a multipart body into its raw part strings, boundary markers stripped. */
function splitMultipart(rawBody, boundary) {
  const text = toText(rawBody);
  const marker = `--${boundary}`;
  const segments = text.split(marker);

  const parts = [];
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.startsWith('--')) break; // the closing "--boundary--" marker

    const trimmed = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (trimmed.length) parts.push(trimmed);
  }
  return parts;
}

function splitHeadersAndBody(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { headerBlock: text, body: '' };
  return { headerBlock: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

function parseHeaderBlock(headerBlock) {
  const headers = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return headers;
}

/** One embedded `application/http` part: a request-line/status-line, headers, and a body. */
function parseHttpEnvelope(text, { isResponse }) {
  const { headerBlock, body } = splitHeadersAndBody(text);
  const [firstLine, ...headerLines] = headerBlock.split(/\r?\n/);

  if (isResponse) {
    const m = /^HTTP\/[\d.]+\s+(\d+)\s*(.*)$/.exec((firstLine || '').trim());
    return {
      kind: 'single',
      status: m ? Number(m[1]) : 200,
      statusText: m ? m[2].trim() : 'OK',
      headerLines: headerLines.filter((l) => l.trim().length > 0),
      body
    };
  }

  const m = /^(\S+)\s+(\S+)\s+HTTP\/[\d.]+$/.exec((firstLine || '').trim());
  return {
    kind: 'single',
    method: m ? m[1] : undefined,
    url: m ? m[2] : undefined,
    headerLines: headerLines.filter((l) => l.trim().length > 0),
    body
  };
}

/** Parses one top-level (or changeset-nested) batch part, recursing into changesets. */
function parseBatchPart(rawPart, { isResponse }) {
  const { headerBlock, body } = splitHeadersAndBody(rawPart);
  const headers = parseHeaderBlock(headerBlock);
  const contentType = headers['content-type'] || '';

  if (/multipart\/mixed/i.test(contentType)) {
    const nestedBoundary = extractBoundary(contentType);
    return {
      kind: 'changeset',
      boundary: nestedBoundary,
      parts: nestedBoundary ? splitMultipart(body, nestedBoundary).map((p) => parseBatchPart(p, { isResponse })) : []
    };
  }

  return parseHttpEnvelope(body, { isResponse });
}

/**
 * @param {string|Buffer} rawBody the $batch request body
 * @param {string} boundary from the request's Content-Type header
 * @returns {object[]} tree of `{ kind: 'single', method, url, ... } | { kind: 'changeset', boundary, parts }`
 */
function parseBatchRequests(rawBody, boundary) {
  return splitMultipart(rawBody, boundary).map((p) => parseBatchPart(p, { isResponse: false }));
}

/**
 * @param {string|Buffer} rawBody the $batch response body
 * @param {string} boundary from the response's Content-Type header
 * @returns {object[]} tree of `{ kind: 'single', status, statusText, headerLines, body } | { kind: 'changeset', boundary, parts }`
 */
function parseBatchResponses(rawBody, boundary) {
  return splitMultipart(rawBody, boundary).map((p) => parseBatchPart(p, { isResponse: true }));
}

function serializeEnvelope(envelope) {
  const startLine = `HTTP/1.1 ${envelope.status} ${envelope.statusText}`;
  const headerText = envelope.headerLines.map((l) => `${l}\r\n`).join('');
  return `${startLine}\r\n${headerText}\r\n${envelope.body}`;
}

/**
 * Re-serializes a (possibly mutated) response tree — see parseBatchResponses()
 * — back into a valid `multipart/mixed` body using `boundary`.
 *
 * @param {object[]} items as returned by parseBatchResponses()
 * @param {string} boundary
 * @returns {string}
 */
function serializeBatchResponses(items, boundary) {
  let out = '';

  for (const item of items) {
    out += `--${boundary}\r\n`;

    if (item.kind === 'changeset') {
      out += `Content-Type: multipart/mixed; boundary=${item.boundary}\r\n\r\n`;
      out += serializeBatchResponses(item.parts, item.boundary);
    } else {
      out += `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
      out += `${serializeEnvelope(item)}\r\n`;
    }
  }

  out += `--${boundary}--\r\n`;
  return out;
}

module.exports = { extractBoundary, splitMultipart, parseBatchRequests, parseBatchResponses, serializeBatchResponses };
