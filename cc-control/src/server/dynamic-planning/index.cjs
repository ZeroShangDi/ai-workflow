'use strict';

const config = require('./config.cjs');
const planner = require('./planner.cjs');
const service = require('./service.cjs');
const store = require('./store.cjs');
const decisionPort = require('./decision-port.cjs');

module.exports = { ...config, ...planner, ...service, ...store, ...decisionPort };
