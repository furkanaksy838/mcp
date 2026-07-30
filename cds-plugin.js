'use strict';

// CAP auto-discovers this file (SAP's "cds-plugin.js" convention) as soon as
// cap-mcp-guard is a dependency of the host project — no wiring required.
const { registerCapMcpGuard } = require('./lib/adapters/cap');

/**
 * Returns the @sap/cds instance the *host project* is running on.
 *
 * A plain `require('@sap/cds')` resolves relative to this file, which is correct for a
 * normal `npm install` (it walks up to the host project's node_modules) but wrong whenever
 * this package is linked rather than copied — `npm link`, a `file:` dependency, or a
 * monorepo/workspace layout. There, this file's real path sits outside the host project, so
 * resolution finds cap-mcp-guard's own peer copy of @sap/cds instead of the host's. The two
 * copies are separate module instances with separate singleton state: the guard would attach
 * to a `cds` whose `cds.db` is never connected, and the host server dies at boot with
 * "Can't execute query as no primary database is connected".
 *
 * Resolving from the host's directory first returns the already-loaded host instance (same
 * resolved path → same require cache entry), so there is only ever one @sap/cds in play.
 */
function requireHostCds() {
  try {
    return require(require.resolve('@sap/cds', { paths: [process.cwd()] }));
  } catch {
    // No @sap/cds reachable from the host directory (unusual — e.g. an exotic runner that
    // changes cwd before loading plugins). Fall back to this file's own resolution.
    return require('@sap/cds');
  }
}

registerCapMcpGuard(requireHostCds());
