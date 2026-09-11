# CLI 辅助命令 — 测试用例

> 对应功能文档：docs/features/cli-aux.md
> 源码：`src/cli/plugin.js`、`src/cli/server.js`、`src/cli/open.js`、`src/cli/attach.js`
> 测试文件：`tests/unit/cli-aux.test.js`

## 测试场景总览

| # | 模块 | 场景 | 类别 |
|---|------|------|------|
| 1 | plugin | install：全局正常安装（读 settings.json.plugins） | 正常 |
| 2 | plugin | install：已用户级安装 → skip | 正常 |
| 3 | plugin | uninstall：全局正常卸载 | 正常 |
| 4 | plugin | install：exec 失败报错不阻断 | 错误 |
| 5 | plugin | uninstall：exec 失败报错不阻断 | 错误 |
| 6 | plugin | 无效 action → 报错退出 | 错误 |
| 7 | server | start：首次启动完整流程 | 正常 |
| 8 | server | start：已运行则跳过 server 启动 | 正常 |
| 9 | server | start：tmux session 已存在跳过创建 | 正常 |
| 10 | server | start：tmux session 不存在时创建 | 正常 |
| 11 | server | stop：优雅关闭失败 → kill tmux + lsof 兜底 | 正常 |
| 11b | server | stop：优雅关闭成功 → 不再 kill-by-port | 正常 |
| 12/14 | server | status：运行中返回 URL | 正常 |
| 13/14b | server | status：未运行 / 超时返回提示 | 正常 |
| 15 | server | 无效 action → 报错退出 | 错误 |
| 16 | open | dashboard：带项目作用域 URL | 正常 |
| 17 | open | ui：已废弃 → 报错退出 | 错误 |
| 18 | open | tree：指向 web WBS-Tree 视图 | 正常 |
| 21 | open | openBrowser：平台选择 + spawn 参数 | 平台 |
| 22 | open | 无效 target → 报错退出 | 错误 |
| 23 | attach | session 存在 → attach | 正常 |
| 24 | attach | session 不存在 → 报错退出 | 错误 |

## 详细测试用例

### TC1: plugin install — 全局正常安装

**前置条件**：`plugin/settings.json.plugins` 含 `ai-workflow-code@ai-workflow-dev`；无旧 symlink；`installed_plugins.json` 为 `{plugins:{}}`

**执行**：`pluginCommand('install', { scope: 'global' })`

**断言**：
- `exec('claude plugin install ai-workflow-code@ai-workflow-dev', ...)` 被调用
- `logStep('ai-workflow-code', 'ok', '已安装')`

---

### TC2: plugin install — 已用户级安装 → skip

**前置条件**：`installed_plugins.json` 中该 spec 有 `[{scope:'user'}]`

**断言**：`exec` **未**调用；`logStep('ai-workflow-code', 'skip', '已安装')`

---

### TC3: plugin uninstall — 全局正常卸载

**断言**：`exec('claude plugin uninstall ai-workflow-code@ai-workflow-dev', ...)` 被调用；`logStep(...,'ok','已卸载')`

---

### TC4/TC5: install / uninstall exec 失败 → 报错不阻断

**前置条件**：`exec` 回调 `cb(new Error('boom'))`

**断言**：`logStep(..., 'error', 含 '安装失败'/'卸载失败')`；流程继续（不抛）

---

### TC6: plugin 无效 action → 报错退出

**执行**：`pluginCommand('invalid')`（默认 local scope）

**断言**：`logger.error('未知操作: invalid，可用: install | uninstall')`；`process.exit(1)` 被调用

---

### TC7: server start — 首次启动完整流程

**前置条件**：`getStatus` 首次失败（无服务），tmux session 不存在

**执行**：`serverCommand('start')`（推进计时器）

**断言**：
- `spawn('node', ['/tmp/server.cjs'], ...)` 被调用
- `execSync(<含 bootstrap>)` 被调用（创建 session）

---

### TC8: server start — 已运行则跳过

**前置条件**：`getStatus` 返回就绪

**断言**：`spawn` **未**调用

---

### TC9/TC10: server start — tmux session 存在 / 不存在

| TC | 前置 | 断言 |
|----|------|------|
| TC9 | session 已存在 | **未**执行含 `bootstrap` 的 execSync |
| TC10 | session 不存在 | 执行含 `bootstrap` 的 execSync |

---

### TC11/TC11b: server stop

| TC | 前置 | 断言 |
|----|------|------|
| TC11 | `/shutdown` 探测失败 | `execSync(含 'tmux kill-session')` 与 `execSync(含 'lsof')` 均被调用；`logger.success('已停止')` |
| TC11b | `/shutdown` 返回 ok | fetch 命中 `/shutdown`；执行 `tmux kill-session`；**未**执行 `lsof`；`logger.success('已停止')` |

---

### TC12/TC13/TC14/TC14b: server status

| TC | 前置 | 断言 |
|----|------|------|
| TC12/14 | `getStatus` 就绪 | `logger.success('tmux-http 运行中: http://localhost:8787')` |
| TC13/14b | 无服务 / 超时 | `logger.info('tmux-http 未运行')` |

---

### TC15: server 无效 action → 报错退出

**执行**：`serverCommand('restart')`

**断言**：`logger.error('未知操作: restart，可用: start | stop | status')`；`process.exit(1)`

---

### TC16: open dashboard — 带项目作用域 URL

**前置条件**：`cwd = /tmp/mock-cwd`（scope = `p=%2Ftmp%2Fmock-cwd`）

**断言**：
- `logger.info('打开 dashboard: http://localhost:8787/?p=%2Ftmp%2Fmock-cwd')`
- `spawn('open', ['http://localhost:8787/?p=%2Ftmp%2Fmock-cwd'], ...)`

---

### TC17: open ui — 已废弃 → 报错退出（T1-094）

**执行**：`openCommand('ui')`

**断言**：`logger.error('未知目标: ui，可用: tree | dashboard')`；`process.exit(1)`

---

### TC18: open tree — 指向 web WBS-Tree 视图

**断言**：
- `logger.info(含 'WBS-Tree')`
- `spawn('open', ['http://localhost:8787/?view=wbs-tree&p=%2Ftmp%2Fmock-cwd'], ...)`
- `fs.writeFile` **未**调用（不再生成 `w-tree.html`）

---

### TC21: openBrowser — 平台选择 + spawn 参数

**执行**：遍历 `darwin/win32/linux` 调 `openCommand('dashboard')`

**断言**：spawn 命令分别为 `open` / `start` / `xdg-open`；args 为 `[url]`；opts 为 `{ stdio:'ignore', detached:true }`；返回的 proc 调用了 `unref()`

---

### TC22: open 无效 target → 报错退出

**断言**：`logger.error('未知目标: invalid，可用: tree | dashboard')`；`process.exit(1)`

---

### TC23: attach — session 存在

**前置条件**：`tmux has-session` 成功

**断言**：
- `logger.info("接入 session 'cc'（Ctrl-B D 脱离）...")`
- `execSync('tmux attach -t cc', { stdio: 'inherit' })`

---

### TC24: attach — session 不存在

**前置条件**：`tmux has-session` 抛错

**断言**：`logger.error("tmux session 'cc' 不存在，请先执行 awf run")`；`process.exit(1)`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `src/lib/ui/log.js` | `vi.mock` | `logger` / `logStep` 记录调用 |
| `node:child_process` (execSync/exec/spawn) | `vi.mock`（helper） | 控制 tmux / claude plugin / 浏览器 spawn |
| `src/lib/paths.js` | `vi.mock` | 固定 `projectRoot` / `tmuxServer` / `bootstrapScript` |
| `src/lib/run-context.cjs` | `vi.mock` | 固定 session / port / serverScriptPath / bootstrapScriptPath（装配器取代旧 getPaths 注入点） |
| `src/lib/server-log.js` | `vi.mock` | 避免真实落盘 |
| `node:http` | `vi.mock` | 控制 `/status` 探测（200 / ECONNREFUSED / timeout） |
| `global.fetch` | `vi.stubGlobal` | 控制 stop 的 `/shutdown` 响应，避免打到真实 8787 |

> 说明：`plugin` 的本地 scope（`installProfile`/`installProjectMcp`）由 `tests/unit/init.test.js` 与 `tests/unit/plugin-config.test.js` 覆盖；本节 TC1–TC6 覆盖全局 scope 与无效 action。
