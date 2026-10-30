'use strict';
/**
 * tooling.cjs — cc tooling 端口（plugin 安装/市场运维；claude 字面只在此）
 *
 * cli/plugin.js 的 `claude plugin marketplace add / install / uninstall` shell 命令字面
 * 收口到本 adapter（build* 构造命令；install/uninstall 可注入 execAsync 执行）。
 */

/** 注册 marketplace（指向 plugin/ 根，幂等）命令 */
function buildMarketplaceAdd(marketplaceDir) {
  // 路径加双引号：marketplaceDir 可能含空格，不加会被 shell 拆成多个参数
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

/**
 * 安装：经注入 execAsync 执行；不注入时**只返回命令字符串**、不真跑。
 * 这样同一函数既能当「执行器」（生产传入 execAsync），又能当「命令构造器」（调用方自己 exec）——
 * 默认分支返回 Promise.resolve(cmd) 保持调用方 await 语义一致。
 */
function install(spec, { execAsync } = {}) {
  const cmd = buildInstall(spec);
  if (typeof execAsync === 'function') return execAsync(cmd);
  return Promise.resolve(cmd);
}

/** 卸载（语义同 install） */
function uninstall(spec, { execAsync } = {}) {
  const cmd = buildUninstall(spec);
  if (typeof execAsync === 'function') return execAsync(cmd);
  return Promise.resolve(cmd);
}

/** claude 可用性探针（command -v claude；供 init 检查）；找不到 → false，不抛 */
function claudeAvailable({ execSync } = {}) {
  // 默认 execSync 惰性 require（同 host.cjs 的理由：避免模块加载即锁死依赖、便于测试注入）
  const run = execSync || ((cmd) => require('node:child_process').execSync(cmd, { stdio: 'ignore' }));
  try {
    run('command -v claude');
    return true;
  } catch {
    return false;
  }
}

module.exports = { buildMarketplaceAdd, buildInstall, buildUninstall, install, uninstall, claudeAvailable };
