# awf plugin / server / open / attach — 测试用例文档

> 对应需求文档：`docs/features/cli-aux.md`
> 源码文件：`src/cli/plugin.js`, `server.js`, `open.js`, `attach.js`
> 测试文件：`tests/unit/cli-aux.test.js`

---

## 测试场景总览

| # | 模块 | 场景 | 类别 |
|---|------|------|------|
| 1 | plugin | install: 正常创建 symlink | 正常 |
| 2 | plugin | install: 已存在则跳过 | 正常 |
| 3 | plugin | uninstall: 正常移除 symlink | 正常 |
| 4 | plugin | uninstall: 目标为目录则递归删除 | 正常 |
| 5 | plugin | uninstall: 不存在则跳过 | 正常 |
| 6 | plugin | 无效 action → 报错退出 | 错误 |
| 7 | server | start: 首次启动完整流程 | 正常 |
| 8 | server | start: 已运行则跳过 server 启动 | 正常 |
| 9 | server | start: tmux session 已存在跳过创建 | 正常 |
| 10 | server | start: tmux session 不存在时创建 | 正常 |
| 11 | server | stop: tmux kill + 端口释放 | 正常 |
| 12 | server | status: 运行中返回 URL | 正常 |
| 13 | server | status: 未运行返回提示 | 正常 |
| 14 | server | check(): 200 → true / 错误 → false | 正常 |
| 15 | server | 无效 action → 报错退出 | 错误 |
| 16 | open | dashboard: 打开 http://localhost:8787 | 正常 |
| 17 | open | ui: 同 dashboard | 正常 |
| 18 | open | tree: 正常渲染 HTML | 正常 |
| 19 | open | tree: wbs 为空时报错 | 正常 |
| 20 | open | tree: state.json 不存在 | 错误 |
| 21 | open | openBrowser: darwin → open | 平台 |
| 22 | open | 无效 target → 报错退出 | 错误 |
| 23 | attach | session 存在 → attach | 正常 |
| 24 | attach | session 不存在 → 报错退出 | 错误 |

---

## 详细测试用例

### TC1: plugin install — 正常创建 symlink

**前置条件**：`~/.claude/plugins/` 存在，`ai-workflow` 不存在

**执行**：`pluginCommand('install')`

**断言**：
- `fs.mkdir(claudePlugins, { recursive: true })` 被调用
- `fs.stat(pluginDir)` 返回不存在
- `fs.symlink(sourceDir, pluginDir)` 被调用（sourceDir = `{projectRoot}/plugin`）
- `logger.success` 输出包含 "已安装"

---

### TC2: plugin install — 已存在则跳过

**前置条件**：`~/.claude/plugins/ai-workflow` 已存在

**执行**：`pluginCommand('install')`

**断言**：
- `fs.stat(pluginDir)` 返回有效 stat
- `fs.symlink` 不被调用
- `logger.info` 输出 "插件已安装，跳过"

---

### TC3: plugin uninstall — 正常移除 symlink

**前置条件**：`~/.claude/plugins/ai-workflow` 存在且为 symlink

**执行**：`pluginCommand('uninstall')`

**断言**：
- `fs.lstat(pluginDir)` 返回 stat，`isSymbolicLink()` → true
- `fs.unlink(pluginDir)` 被调用
- `logger.success` 输出 "已卸载"

---

### TC4: plugin uninstall — 目标为目录则递归删除

**前置条件**：`~/.claude/plugins/ai-workflow` 存在且为真实目录（非 symlink）

**执行**：`pluginCommand('uninstall')`

**断言**：
- `fs.lstat` → `isSymbolicLink()` → false
- `fs.rm(pluginDir, { recursive: true })` 被调用

---

### TC5: plugin uninstall — 不存在则跳过

**前置条件**：`~/.claude/plugins/ai-workflow` 不存在

**执行**：`pluginCommand('uninstall')`

**断言**：
- `fs.lstat` 抛出 ENOENT
- `logger.info` 输出 "插件未安装"
- 正常返回

---

### TC6: plugin 无效 action → 报错退出

**前置条件**：action 为 `'invalid'`

**执行**：`pluginCommand('invalid')`

**断言**：
- `logger.error` 输出 "未知操作: invalid，可用: install | uninstall"
- `process.exit(1)` 被调用

---

### TC7: server start — 首次启动完整流程

**前置条件**：8787 端口无服务，tmux session 不存在

**执行**：`serverCommand('start')`

**断言**：
- `check()` 返回 false
- `spawn('node', [paths.tmuxServer], ...)` 被调用，env 包含 `CC_PORT=8787`
- 轮询 `check()` 等待 server 就绪
- `tmux has-session` 执行失败（不存在）
- `logger.info('创建 tmux session...')`
- `execSync('bash bootstrap.sh')` 被调用
- `logger.success` 输出环境就绪信息

---

### TC8: server start — 已运行则跳过 server 启动

**前置条件**：8787 端口已有服务响应

**执行**：`serverCommand('start')`

**断言**：
- `check()` 返回 true
- `spawn('node', ...)` 不被调用
- 直接进入 tmux session 检查

---

### TC9: server start — tmux session 已存在跳过创建

**前置条件**：server 运行中，tmux session `cc` 已存在

**执行**：`serverCommand('start')`

**断言**：
- `tmux has-session -t cc` 成功
- `execSync('bash bootstrap.sh')` 不被调用
- 直接输出就绪信息

---

### TC10: server start — tmux session 不存在时创建

**前置条件**：server 运行中，tmux session `cc` 不存在

**执行**：`serverCommand('start')`

**断言**：
- `tmux has-session -t cc` 失败
- `execSync('bash bootstrap.sh')` 被调用

---

### TC11: server stop — tmux kill + 端口释放

**前置条件**：server 和 tmux session 均在运行

**执行**：`serverCommand('stop')`

**断言**：
- `execSync('tmux kill-session -t cc')` 被调用
- `execSync` 包含 `lsof -ti:8787` 和 `xargs kill`
- `logger.success` 输出 "已停止"

---

### TC12: server status — 运行中返回 URL

**前置条件**：server 在 8787 端口响应 200

**执行**：`serverCommand('status')`

**断言**：
- `check()` 返回 true
- `logger.success` 输出 "tmux-http 运行中: http://localhost:8787"

---

### TC13: server status — 未运行返回提示

**前置条件**：8787 端口无服务

**执行**：`serverCommand('status')`

**断言**：
- `check()` 返回 false
- `logger.info` 输出 "tmux-http 未运行"

---

### TC14: server check() — 正常/异常

**前置条件**：server 响应 200 / 无服务

**执行**：`check()`

**断言**：
- 200 响应 → resolve(true)
- error 事件 → resolve(false)
- 2s 超时 → req.destroy() → resolve(false)

---

### TC15: server 无效 action → 报错退出

**前置条件**：action 为 `'restart'`

**执行**：`serverCommand('restart')`

**断言**：
- `logger.error` 输出 "未知操作: restart，可用: start | stop | status"
- `process.exit(1)` 被调用

---

### TC16: open dashboard — 打开 URL

**前置条件**：SERVER_PORT = 8787

**执行**：`openCommand('dashboard')`

**断言**：
- `logger.info` 输出 "打开 dashboard: http://localhost:8787"
- `openBrowser('http://localhost:8787')` 被调用
- 不读取 .awf/state.json

---

### TC17: open ui — 同 dashboard

**前置条件**：SERVER_PORT = 8787

**执行**：`openCommand('ui')`

**断言**：
- 行为与 dashboard 完全相同
- `openBrowser('http://localhost:8787')` 被调用

---

### TC18: open tree — 正常渲染 HTML

**前置条件**：`.awf/state.json` 存在，`state.wbs` 有数据

**执行**：`openCommand('tree')`

**断言**：
- `fs.readFile('.awf/state.json')` 被调用
- `state.wbs` 非空，不触发 exit
- `fs.writeFile('.awf/w-tree.html', html)` 被调用
- `html` 中包含 `JSON.stringify(state.wbs)`
- `openBrowser(outPath)` 被调用
- `logger.success` 输出文件路径

---

### TC19: open tree — wbs 为空时报错

**前置条件**：`.awf/state.json` 存在，`state.wbs = null` 或不存在

**执行**：`openCommand('tree')`

**断言**：
- `logger.error` 输出 "尚未规划，请先执行 awf plan"
- `process.exit(1)` 被调用
- HTML 不渲染，文件不写入

---

### TC20: open tree — state.json 不存在

**前置条件**：`.awf/state.json` 不存在

**执行**：`openCommand('tree')`

**断言**：
- `fs.readFile` 抛出 ENOENT
- 异常传播（未被 catch）

---

### TC21: openBrowser — 平台选择

**前置条件**：darwin 平台

**执行**：`openBrowser('http://localhost:8787')`

**断言**：
- `spawn('open', ['http://localhost:8787'], { stdio: 'ignore', detached: true })` 被调用
- proc.unref() 被调用
- win32 → `start`，其他 → `xdg-open`

---

### TC22: open 无效 target → 报错退出

**前置条件**：target 为 `'invalid'`

**执行**：`openCommand('invalid')`

**断言**：
- `logger.error` 输出 "未知目标: invalid，可用: tree | ui | dashboard"
- `process.exit(1)` 被调用

---

### TC23: attach — session 存在

**前置条件**：tmux session `cc` 存在

**执行**：`attachCommand()`

**断言**：
- `execSync('tmux has-session -t cc')` 不抛异常
- `logger.info` 输出 "接入 session 'cc'（Ctrl-B D 脱离）..."
- `execSync('tmux attach -t cc', { stdio: 'inherit' })` 被调用

---

### TC24: attach — session 不存在

**前置条件**：tmux session `cc` 不存在

**执行**：`attachCommand()`

**断言**：
- `execSync('tmux has-session -t cc')` 抛出异常（被 catch）
- `logger.error` 输出 "tmux session 'cc' 不存在，请先执行 awf run"
- `process.exit(1)` 被调用
- `tmux attach` 不被调用

---

## Mock 策略

| 模块 | Mock 依赖 | 方式 |
|------|-----------|------|
| plugin | `node:fs/promises` | `vi.mock`，控制 stat/symlink/unlink/rm/mkdir 返回值 |
| plugin | `./paths.js` | 返回固定 projectRoot / claudePlugins |
| server | `node:child_process.spawn` | 控制 server 启动，验证 args |
| server | `node:child_process.execSync` | 控制 tmux has-session、kill、lsof、bootstrap |
| server | `node:http` | 控制 `/status` 响应（200 / ECONNREFUSED / timeout） |
| open | `node:child_process.spawn` | 验证 openBrowser 参数 |
| open | `node:fs/promises` | 控制 state.json 读取 + HTML 写入 |
| attach | `node:child_process.execSync` | 控制 tmux has-session 成功/失败、attach 参数 |
| 全部 | `./logger.js` | 静默输出，记录调用 |
