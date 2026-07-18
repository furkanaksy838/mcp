'use strict';

const { buildContext } = require('./core/context');
const { attachInterceptor } = require('./core/interceptor');

module.exports = { buildContext, attachInterceptor };