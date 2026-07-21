'use strict';

const path = require('path');

const { buildContext } = require('../core/context');
const { resolveEntityPath, resolveOperation, isBatchRequest, collectMaskableGroups } = require('../core/odata');
const { parseMetadata, parseExpandOption } = require('../core/edm');
const { extractBoundary, parseBatchRequests, parseBatchResponses, serializeBatchResponses } = require('../core/odata-batch');
const { evaluate } = require('../policy/evaluator');
const { maskFields } = require('../policy/masking');
const { loadConfig } = require('../policy/config');
const { logAudit } = require('../audit/log');
const { exportSpan } = require('../otel/exporter');

const CONFIG_FILE_NAME = 'cap-mcp-guard.yaml';
const NOT_FOUND_PREFIX = `${CONFIG_FILE_NAME} not found`;

/**
 * Loads cap-mcp-guard.yaml from `cwd` — same convention and same file
 * lib/adapters/cap.js reads, so one policy file covers both a CAP app's
 * own service layer and any OData traffic this middleware fronts. A
 * missing config is a valid "not configured yet" state (pass-through); a
 * config that exists but fails to parse propagates (see cap.js for the
 * same reasoning).
 *
 * @param {string} [cwd] defaults to process.cwd()
 */
function resolvePolicyDefinition(cwd) {
  const configPath = path.join(cwd || process.cwd(), CONFIG_FILE_NAME);

  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err.message.startsWith(NOT_FOUND_PREFIX)) {
      console.warn('[cap-mcp-guard] no config found, running in pass-through mode (no policies enforced)');
      return { mode: 'observe', entities: {} };
    }
    throw err;
  }
}

/**
 * OData has no MCP-runtime `_meta` bag to read (that's a CAP/CDS-side
 * convention) — the wire-level equivalent is plain HTTP headers, which any
 * proxying MCP runtime can set alongside a request it forwards.
 */
function extractTraceContext(req) {
  const headers = (req && req.headers) || {};
  return { traceparent: headers.traceparent, tracestate: headers.tracestate };
}

function extractAgentInfo(req) {
  const headers = (req && req.headers) || {};
  return {
    agentId: headers['x-gen-ai-agent-id'],
    agentName: headers['x-gen-ai-agent-name'],
    model: headers['x-gen-ai-request-model']
  };
}

function getExpandTree(url) {
  const query = (url || '').split('?')[1];
  if (!query) return {};

  const expand = new URLSearchParams(query).get('$expand');
  return parseExpandOption(expand);
}

/**
 * Same in-place-mutation strategy as lib/core/interceptor.js's applyMask:
 * maskFields() itself stays pure, this is the one place that turns its
 * (immutable) output into a real effect on the rows already referenced
 * inside the response body (see extractResultRows / collectMaskableGroups).
 */
function applyMask(rows, fieldsToMask) {
  const masked = maskFields(rows, fieldsToMask);

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    for (const field of fieldsToMask) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        row[field] = masked[i][field];
      }
    }
  });
}

/**
 * Builds an Express-compatible middleware `(req, res, next)` that runs the
 * same Context → Decision → mask/audit/OTel pipeline as
 * lib/adapters/cap.js, driven off raw OData HTTP request/response instead
 * of CAP's before()/after() hooks. Mount it in front of ANY OData V2/V4
 * traffic — a hand-rolled OData service, a proxy route to SAP Gateway or
 * S/4HANA, a CAP Java service, or this same CAP Node app's own OData
 * endpoint — regardless of what produced it, since it only ever looks at
 * the HTTP request/response, never at a CDS model.
 *
 * Entity resolution is URL-path-based (lib/core/odata.js's
 * resolveEntityPath()). Without `metadataXml`/`edm`, it's a last-path-
 * segment heuristic, same as before; pass either one to resolve deep
 * paths (`Books(201)/author`) and `$expand`'ed nested entities
 * (`?$expand=author`) against the real EDM, so masking reaches nested
 * data too, not just the top-level rows.
 *
 * `$batch` requests are decoded on BOTH wire formats, each sub-request
 * masked/audited/traced individually exactly like a standalone request:
 *   - OData V4 JSON batch (`{ requests: [...] }` request body /
 *     `{ responses: [...] }` response body) — requires `req.body` to
 *     already be the parsed JSON request (i.e. a JSON body-parser like
 *     `express.json()` ran before this middleware).
 *   - Classic OData V2 `multipart/mixed` batch (see lib/core/odata-batch.js)
 *     — requires `req.body` to already be the raw request Buffer/string
 *     (e.g. `express.raw({ type: 'multipart/mixed' })` ran before this
 *     middleware) and goes out via `res.send(rawBody)`, not `res.json()`.
 * If a batch can't be decoded either way (wrong/missing `req.body`,
 * missing boundary, malformed MIME), it still produces one Context/
 * Decision/audit entry (with an undefined entity) so it isn't silently
 * unaccounted for — it's just unmasked.
 *
 * Response bodies are only inspected when the downstream handler calls
 * `res.json(body)` (always) or, for a batch request specifically,
 * `res.send(rawBody)` too — this middleware wraps those methods for the
 * life of the request. If `res.json` isn't a function (a bare Node `http`
 * response, or a framework that never provides it), the middleware warns
 * once and passes every request through unguarded rather than throwing.
 *
 * @param {object} [options]
 * @param {object} [options.policyDefinition] see lib/policy/config.js —
 *   when omitted, loaded from cap-mcp-guard.yaml in options.cwd
 * @param {string} [options.cwd] directory cap-mcp-guard.yaml is resolved
 *   from when policyDefinition isn't supplied — defaults to process.cwd()
 * @param {string} [options.metadataXml] a `$metadata` EDMX/CSDL document
 *   (already fetched — this module never makes network calls itself),
 *   parsed once via lib/core/edm.js's parseMetadata()
 * @param {object} [options.edm] an already-parsed EDM (see
 *   lib/core/edm.js parseMetadata()) — takes precedence over metadataXml
 * @param {(context: object, req: object) => void} [options.onContext]
 *   called with the built context after each request completes
 * @param {object|false} [options.audit] forwarded to logAudit()'s write
 *   options (`{ stdout, filePath }`); pass `false` to disable audit
 *   logging entirely
 * @param {object|false} [options.otel] forwarded to exportSpan()'s options
 *   (`{ tracer }`); pass `false` to skip OTel span export entirely
 * @param {(decision: object, context: object, req: object) => void} [options.onDecision]
 *   called in addition to the built-in audit log and OTel export, not
 *   instead of them
 * @param {() => string} [options.now] injectable clock, forwarded to buildContext
 * @returns {(req: object, res: object, next: Function) => void}
 */
function odataMcpGuard(options = {}) {
  const policyDefinition = options.policyDefinition || resolvePolicyDefinition(options.cwd);
  const { onContext, onDecision: userOnDecision, audit, otel, now } = options;
  const edm = options.edm || (options.metadataXml && parseMetadata(options.metadataXml));
  const clockDeps = now ? { now } : {};

  let warnedNoJson = false;

  /**
   * The full Context → Decision → mask/audit/OTel pipeline for one logical
   * request — either the request as a whole, or (for a decoded $batch)
   * one of its sub-requests. Mutates `rows` in place when enforcing.
   */
  function runPipeline({ req, entity, operation, rows, rowCount, durationMs }) {
    const context = buildContext(
      {
        ...extractAgentInfo(req),
        ...extractTraceContext(req),
        entity,
        operation,
        tenant: req.headers && req.headers['sap-tenantid'],
        user: req.user && (req.user.id || req.user.name),
        session: req.headers && req.headers['x-request-id'],
        rowCount,
        durationMs
      },
      clockDeps
    );

    if (typeof onContext === 'function') onContext(context, req);
    if (!policyDefinition) return;

    const decision = evaluate(context, policyDefinition);

    if (decision.mode === 'enforce' && decision.fieldsToMask.length > 0) {
      applyMask(rows, decision.fieldsToMask);
    }

    if (audit !== false) logAudit(context, decision, audit);
    if (otel !== false) exportSpan(context, decision, otel);
    if (typeof userOnDecision === 'function') userOnDecision(decision, context, req);
  }

  /** Runs one sub-request's worth of the pipeline, grouping $expand-ed nested entities too. */
  function runSubRequestPipeline(req, url, method, responseBody, durationMs) {
    const entity = resolveEntityPath(url, edm);
    const operation = resolveOperation(method);
    const expandTree = getExpandTree(url);
    const groups = collectMaskableGroups(responseBody, entity, expandTree, edm);

    if (groups.length === 0) {
      runPipeline({ req, entity, operation, rows: [], rowCount: responseBody === undefined ? undefined : 0, durationMs });
      return;
    }

    for (const group of groups) {
      runPipeline({ req, entity: group.entity, operation, rows: group.rows, rowCount: group.rows.length, durationMs });
    }
  }

  /**
   * Decodes and guards an OData V4 JSON batch: `req.body.requests` (each
   * `{ id, method, url, ... }`) matched by `id` to `body.responses` (each
   * `{ id, status, body, ... }`), so every sub-request is resolved,
   * evaluated, and masked exactly like a standalone request would be.
   * Returns false (nothing decoded — caller falls back to legacy
   * pass-through) when either side isn't shaped like a V4 JSON batch.
   */
  function runJsonBatchPipeline(req, body, durationMs) {
    const requests = req.body && Array.isArray(req.body.requests) ? req.body.requests : undefined;
    const responses = body && Array.isArray(body.responses) ? body.responses : undefined;
    if (!requests || !responses) return false;

    const requestById = new Map(requests.map((r) => [r.id, r]));

    for (const responseEntry of responses) {
      const subRequest = requestById.get(responseEntry.id);
      if (!subRequest || !subRequest.url) continue;

      runSubRequestPipeline(req, subRequest.url, subRequest.method, responseEntry.body, durationMs);
    }

    return true;
  }

  /**
   * Zips a parsed batch request tree to its response tree by position —
   * each top-level (or changeset-nested) request corresponds to exactly
   * one response in the same slot, per OData $batch semantics. Mismatched
   * shapes (a 'single' lined up against a 'changeset', or a length
   * mismatch) are skipped rather than crashing the response.
   */
  function zipClassicBatch(req, requestItems, responseItems, durationMs) {
    const len = Math.min(requestItems.length, responseItems.length);

    for (let i = 0; i < len; i++) {
      const reqItem = requestItems[i];
      const resItem = responseItems[i];

      if (reqItem.kind === 'changeset' && resItem.kind === 'changeset') {
        zipClassicBatch(req, reqItem.parts, resItem.parts, durationMs);
        continue;
      }
      if (reqItem.kind !== 'single' || resItem.kind !== 'single') continue;

      let parsedBody;
      try {
        parsedBody = resItem.body ? JSON.parse(resItem.body) : undefined;
      } catch {
        parsedBody = undefined;
      }

      runSubRequestPipeline(req, reqItem.url, reqItem.method, parsedBody, durationMs);
      if (parsedBody !== undefined) resItem.body = JSON.stringify(parsedBody);
    }
  }

  /**
   * Decodes and guards a classic OData V2 `multipart/mixed` $batch: parses
   * `req.body` (the raw request body — a JSON body-parser won't populate
   * this for a multipart content-type, so the host needs something like
   * `express.raw({ type: 'multipart/mixed' })` mounted first) and the raw
   * response body about to be sent, zips requests to responses by
   * position, masks each response's JSON in place, and returns the
   * re-serialized response body. Returns false (caller falls back to
   * legacy pass-through) when either side can't be decoded as multipart —
   * missing boundary, `req.body` not pre-buffered, or malformed MIME.
   */
  function runClassicBatchPipeline(req, res, rawResponseBody, durationMs) {
    const reqBoundary = extractBoundary(req.headers && req.headers['content-type']);
    const resBoundary = extractBoundary(typeof res.getHeader === 'function' ? res.getHeader('content-type') : undefined);

    const rawRequestBody = req.body;
    const requestIsBufferLike = typeof rawRequestBody === 'string' || Buffer.isBuffer(rawRequestBody);
    const responseIsBufferLike = typeof rawResponseBody === 'string' || Buffer.isBuffer(rawResponseBody);

    if (!reqBoundary || !resBoundary || !requestIsBufferLike || !responseIsBufferLike) return false;

    let requestItems;
    let responseItems;
    try {
      requestItems = parseBatchRequests(rawRequestBody, reqBoundary);
      responseItems = parseBatchResponses(rawResponseBody, resBoundary);
    } catch {
      return false; // malformed multipart — don't crash the response, fall back to legacy pass-through
    }

    zipClassicBatch(req, requestItems, responseItems, durationMs);
    return serializeBatchResponses(responseItems, resBoundary);
  }

  return function odataMcpGuardMiddleware(req, res, next) {
    if (typeof res.json !== 'function') {
      if (!warnedNoJson) {
        console.warn('[cap-mcp-guard] res.json is not available; OData responses will pass through unguarded');
        warnedNoJson = true;
      }
      return next();
    }

    const startedAt = process.hrtime.bigint();
    const operation = resolveOperation(req.method);
    const batch = isBatchRequest(req.url);
    const originalJson = res.json.bind(res);

    // Shared between the res.json and res.send patches below: Express's
    // real res.json() (captured as originalJson) internally calls
    // this.send(...) — since that resolves to OUR patched res.send when
    // `batch` is true, this flag stops the batch already handled by
    // guardedJson from being processed a second time by guardedSend.
    let handled = false;

    res.json = function guardedJson(body) {
      if (handled) return originalJson(body);
      handled = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      if (batch) {
        if (!runJsonBatchPipeline(req, body, durationMs)) {
          // classic multipart/mixed batch that didn't go through res.send,
          // or req.body wasn't pre-parsed: still audited, nothing masked
          runPipeline({ req, entity: undefined, operation, rows: [], rowCount: undefined, durationMs });
        }
        return originalJson(body);
      }

      runSubRequestPipeline(req, req.url, req.method, body, durationMs);
      return originalJson(body);
    };

    // Classic multipart/mixed $batch responses go out via res.send(rawBody),
    // never res.json() — only patch res.send for batch requests, so the
    // (already tested) non-batch path never touches it.
    if (batch && typeof res.send === 'function') {
      const originalSend = res.send.bind(res);

      res.send = function guardedSend(bodyChunk) {
        if (handled) return originalSend(bodyChunk);
        handled = true;

        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const newBody = runClassicBatchPipeline(req, res, bodyChunk, durationMs);

        if (newBody !== false) return originalSend(newBody);

        // couldn't decode as classic multipart batch either: still audited
        runPipeline({ req, entity: undefined, operation, rows: [], rowCount: undefined, durationMs });
        return originalSend(bodyChunk);
      };
    }

    next();
  };
}

module.exports = { odataMcpGuard };
