'use strict';

// CAP auto-discovers this file (SAP's "cds-plugin.js" convention) as soon as
// cap-mcp-guard is a dependency of the host project — no wiring required.
const cds = require('@sap/cds');
const { registerCapMcpGuard } = require('./lib/adapters/cap');

registerCapMcpGuard(cds);