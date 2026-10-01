'use strict';

/**
 * Public persistence API for Server, CLI, MCP and other callers.
 * Methods are grouped by data module. They return { ok, data } or { ok, error };
 * connection management, transactions, SQL and repositories remain internal.
 */
module.exports = require('./api/public-api.cjs');
