'use strict';

const { buildContext } = require('./core/context');
const { attachInterceptor } = require('./core/interceptor');
const { odataMcpGuard } = require('./adapters/odata');

module.exports = { buildContext, attachInterceptor, odataMcpGuard };