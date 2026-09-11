# Bootstrap 模块 — 测试用例

> 对应功能文档：docs/features/bootstrap.md
> 源码：`scripts/bootstrap.sh`
> 测试文件：`tests/integration/bootstrap.test.js`

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | tmux 未安装 → exit 1 | 前置依赖 |
| 2 | claude 未安装 → exit 1 | 前置依赖 |
| 3 | node 未安装 → exit 1（MCP server 需要） | 前置依赖 |
| 4 | 不渲染 settings.json / .mcp.json | 结构 |
| 5 | session 不存在 → 创建（claude 无 `--plugin-dir`） | 正常 |
| 6 | session 已存在 → exit 0 不创建 | 正常 |
| 7 | CC_SESSION 环境变量 → 自定义名称 | 环境变量 |
| 8 | tmux new-session 参数验证 | 参数 |
| 9 | trust prompt 消除（sleep 3 + send-keys Enter） | 边界 |
| 10 | run 会话 env 显式注入 claude | 环境变量 |
| 11 | 未提供的 run 变量不写出空赋值 | 环境变量 |

## 详细测试用例

### TC1: tmux 未安装 → exit 1

**前置条件**：PATH 仅含 `claude`/`node`/`sleep` stub（无 tmux）

**断言**：stderr 含 `tmux not found. Install with: brew install tmux`；退出码 1

---

### TC2: claude 未安装 → exit 1

**前置条件**：PATH 仅含 `tmux`/`node`/`sleep`

**断言**：stderr 含 `claude not found on PATH`；退出码 1

---

### TC3: node 未安装 → exit 1

**前置条件**：PATH 仅含 `tmux`/`claude`/`sleep`

**断言**：stderr 含 `node not found on PATH`；退出码 1

---

### TC4: 不渲染 settings.json / .mcp.json

**前置条件**：正常执行环境（tmux/claude/node stub 齐）

**执行**：`bash scripts/bootstrap.sh`

**断言**：
- 退出码 0
- `<WORKDIR>/.claude/settings.json` **不存在**
- `<WORKDIR>/.mcp.json` **不存在**

即 bootstrap 不写任何配置（插件 / hooks / MCP 由项目 `.claude/settings.json` 注册加载）

---

### TC5: session 不存在 → 创建

**前置条件**：`STUB_HAS_SESSION=0`

**断言**：stub 日志含
- `tmux has-session -t cc`
- `tmux new-session -d -s cc -x 200 -y 50 -c <WORKDIR>`
- `claude --permission-mode bypassPermissions`
- **不含** `--plugin-dir`

---

### TC6: session 已存在 → exit 0 不创建

**前置条件**：`STUB_HAS_SESSION=1`

**断言**：
- stdout 含 `tmux session 'cc' already exists`
- 退出码 0
- stub 日志含 `has-session -t cc`，**不含** `new-session`

---

### TC7: CC_SESSION 环境变量 → 自定义名称

**前置条件**：`CC_SESSION=my-workflow`

**断言**：stub 日志含 `has-session -t my-workflow` 与 `new-session -d -s my-workflow`

---

### TC8: tmux new-session 参数验证

**断言**：`tmux new-session` 行含 `-d`、`-s cc`、`-x 200 -y 50`、`-c <WORKDIR>`，**不含** `--plugin-dir`

---

### TC9: trust prompt 消除

**断言**：
- stub 日志含 `send-keys -t cc Enter`
- 脚本源码含 `sleep 3`

---

### TC10: run 会话 env 显式注入 claude（T1-098）

**前置条件**：`CC_SESSION=cc-env`、`CC_PROJECT=<path>`、`CC_PORT=8899`、`CC_AWF_STATE_SERVER=1`

**执行**：运行 bootstrap，取 `tmux new-session` 行

**断言**：该行含
- `CC_SESSION="cc-env"`
- `CC_WORKDIR="<WORKDIR>"`
- `CC_PROJECT="<path>"`
- `CC_PORT="8899"`
- `CC_AWF_STATE_SERVER="1"`
- 仍保留 `-u DISABLE_GROWTHBOOK`

---

### TC11: 未提供的 run 变量不写出空赋值

**前置条件**：`CC_PROJECT=''`、`CC_PORT=''`、`CC_AWF_STATE_SERVER=''`、`CC_SID=''`

**断言**：`tmux new-session` 行**不**含 `CC_PROJECT=""` / `CC_PORT=""` / `CC_AWF_STATE_SERVER=""` / `CC_SID=""`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| bootstrap.sh | 真实 `bash` 执行 + PATH stub | stub 脚本把调用参数追加到 `STUB_LOG` |
| tmux | PATH 注入 stub | 记录 `has-session` / `new-session` / `set-option` / `send-keys`；`STUB_HAS_SESSION` 控制 session 存在性 |
| claude | PATH 注入 stub | 记录调用，不真正启动 CC |
| node / sleep | PATH 注入空转 stub | node 仅满足 `command -v` 前置检查；sleep 消除尾部等待 |
| filesystem | 临时目录 | `TMP/bin`（stub）、`TMP/work`（WORKDIR）、`TMP/stub.log` 隔离 |
