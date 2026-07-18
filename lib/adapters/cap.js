'use strict';

const { attachInterceptor } = require('../core/interceptor');

/**
 * The single CAP-specific connection point in this package. Everything
 * under lib/core and lib/policy is framework-agnostic; this file is where
 * @sap/cds concepts (served services, cds.ApplicationService) are known.
 *
 * cds-plugin.js is the only caller of this function in production; tests
 * call it directly against a real or in-memory CAP service.
 *
 * @param {object} cds the @sap/cds module (or a compatible facade)
 * @param {object} [options] forwarded to attachInterceptor (see interceptor.js)
 */
function registerCapMcpGuard(cds, options = {}) {
  cds.on('served', () => {
    for (const srv of Object.values(cds.services)) {
      if (srv instanceof cds.ApplicationService) {
        attachInterceptor(srv, options);
      }
    }
  });
}

module.exports = { registerCapMcpGuard };