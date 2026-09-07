'use strict';
/**
 * tooling.cjs — cc tooling 端口（plugin 安装/市场运维；claude 字面只在此）
 *
 * cli/plugin.js 的 `claude plugin marketplace add / install / uninstall` shell 命令字面
 * 收口到本 adapter（build* 构造命令；install/uninstall 可注入 execAsync 执行）。
 */

/** 注册 marketplace（指向 plugin/ 根，幂等）命令 */
function buildMarketplaceAdd(marketplaceDir) {
  return `claude plugin marketplace add "${marketplaceDir}"`;
}

/** 安装命令（spec 形如 'market:name@version' 或 'dir'） */
function buildInstall(spec) {
  return `claude plugin install ${spec}`;
}

/** 卸载命令 */
function buildUninstall(spec) {
  return `claude plugin uninstall ${spec}`;
}

/** 安装：经注入 execAsync（默认返回构造命令，交由调用方 execAsync）执行 */
function install(spec, { execAsync } = {}) {
  const cmd = buildInstall(spec);
  if (typeof execAsync === 'function') return execAsync(cmd);
  return Promise.resolve(cmd);
}

/** 卸载 */
function uninstall(spec, { execAsync } = {}) {
  const cmd = buildUninstall(spec);
  if (typeof execAsync === 'function') return execAsync(cmd);
  return Promise.resolve(cmd);
}

/** claude 可用性探针（command -v claude；供 init 检查） */
function claudeAvailable({ execSync } = {}) {
  const run = execSync || ((cmd) => require('node:child_process').execSync(cmd, { stdio: 'ignore' }));
  try {
    run('command -v claude');
    return true;
  } catch {
    return false;
  }
}

module.exports = { buildMarketplaceAdd, buildInstall, buildUninstall, install, uninstall, claudeAvailable };
