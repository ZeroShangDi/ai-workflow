'use strict';
/**
 * replanning/index.cjs — 动态任务规划能力的统一出口。
 *
 * 把 config / planner / service / store / decision-port 五个模块的命名导出摊平合并，
 * 消费方（如 MCP awf-state server、API 路由）只 require 本文件即可拿到全部能力，
 * 无需关心内部拆分。各子模块的命名导出必须互不重名——否则展开顺序靠后者会静默覆盖前者。
 */

const config = require('./config.cjs');
const planner = require('./planner.cjs');
const service = require('./service.cjs');
const store = require('./store.cjs');
const decisionPort = require('./decision-port.cjs');

module.exports = { ...config, ...planner, ...service, ...store, ...decisionPort };
