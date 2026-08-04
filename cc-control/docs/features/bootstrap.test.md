# Bootstrap 模块 — 测试用例文档

> 对应需求文档：`docs/features/bootstrap.md`
> 源码文件：`scripts/bootstrap.sh` + `src/mcp/mcp.json.template`
> 测试文件：`tests/integration/bootstrap.test.js`

---

## 测试场景总览

### 环境检查 — 2 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | tmux 未安装 → exit 1 | 前置依赖 |
| 2 | claude 未安装 → exit 1 | 前置依赖 |

### 配置渲染 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 3 | settings.json: `__PORT__` 替换正确 | 正常 |
| 4 | .mcp.json: `__TOOLS__` 替换正确 | 正常 |
| 5 | .mcp.json: `__WORKDIR__` 替换正确 | 正常 |
| 6 | .mcp.json: 渲染后 JSON 合法 | 格式 |

### Session 管理 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 7 | session 不存在 → 创建 | 正常 |
| 8 | session 已存在 → exit 0 不创建 | 正常 |
| 9 | CC_SESSION 环境变量 → 自定义名称 | 环境变量 |
| 10 | tmux new-session 参数验证 | 参数 |

### 边界 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 11 | WORKDIR 不存在 → mkdir -p 创建 | 边界 |
| 12 | CC_PORT 自定义端口 | 环境变量 |
| 13 | trust prompt 消除（sleep 3 + Enter） | 正常 |
| 14 | 特殊字符路径 | 边界 |

---

## 详细测试用例

### TC1: tmux 未安装 → exit 1

**前置条件**：tmux 不在 PATH 中

**执行**：`bash bootstrap.sh`

**断言**：
- stderr 输出 "tmux not found. Install with: brew install tmux"
- 退出码 1
- 不执行后续渲染和 session 创建

---

### TC2: claude 未安装 → exit 1

**前置条件**：tmux 可用，claude 不在 PATH 中

**执行**：`bash bootstrap.sh`

**断言**：
- stderr 输出 "claude not found on PATH"
- 退出码 1
- tmux session 未创建

---

### TC3: settings.json `__PORT__` 替换正确

**前置条件**：CC_PORT=9999

**执行**：运行 bootstrap 的渲染步骤

**断言**：
- 输出的 `.claude/settings.json` 中不含 `__PORT__`（全部替换）
- 所有 curl URL 中的端口为 `9999`
- 原模板 `src/server/hooks/settings.json` 不变

---

### TC4: .mcp.json `__TOOLS__` 替换正确

**前置条件**：ROOT=/path/to/cc-control

**执行**：运行渲染步骤

**断言**：
- `.mcp.json` 中 `__TOOLS__/awf-state/server.cjs` → `/path/to/cc-control/src/mcp/awf-state/server.cjs`
- `.mcp.json` 中 `__TOOLS__/awf-session/server.cjs` → `/path/to/cc-control/src/mcp/awf-session/server.cjs`
- `.mcp.json` 中 `__TOOLS__/awf-oneshot/server.cjs` → `/path/to/cc-control/src/mcp/awf-oneshot/server.cjs`
- 原模板文件不变

---

### TC5: .mcp.json `__WORKDIR__` 替换正确

**前置条件**：CC_WORKDIR=/tmp/work

**执行**：运行渲染步骤

**断言**：
- `.mcp.json` 中 `AWF_PROJECT_ROOT` 值为 `"/tmp/work"`

---

### TC6: .mcp.json 渲染后 JSON 合法

**前置条件**：所有占位符替换完成

**执行**：`JSON.parse(fs.readFileSync('.mcp.json'))`

**断言**：
- 不抛异常
- `mcpServers` 包含 3 个 key：awf-state、awf-session、awf-oneshot
- 每个 server 有 `command: "node"` 和 `args` 数组

---

### TC7: session 不存在 → 创建

**前置条件**：tmux session `cc` 不存在

**执行**：运行 bootstrap（mock tmux new-session）

**断言**：
- `tmux has-session -t cc` 返回非零
- `tmux new-session -d -s cc -x 200 -y 50 -c {WORKDIR}` 被调用
- session 命令包含 `claude --plugin-dir ... --permission-mode bypassPermissions`
- 脚本退出码 0

---

### TC8: session 已存在 → exit 0 不创建

**前置条件**：tmux session `cc` 已存在

**执行**：`bootstrap.sh`

**断言**：
- `tmux has-session -t cc` 返回 0
- echo 输出 "tmux session 'cc' already exists..."
- exit 0
- `tmux new-session` 不被调用

---

### TC9: CC_SESSION 环境变量 → 自定义名称

**前置条件**：`CC_SESSION=my-workflow`

**执行**：运行 bootstrap

**断言**：
- `SESSION` 变量 = `my-workflow`
- `tmux has-session -t my-workflow` 被调用
- 不存在时 `tmux new-session -s my-workflow` 被调用

---

### TC10: tmux new-session 参数验证

**前置条件**：mock tmux，CC_SESSION=cc，默认参数

**执行**：检查 `tmux new-session` 调用参数

**断言**：
- `-d` — detached 模式
- `-s cc` — session 名称
- `-x 200 -y 50` — terminal 尺寸固定
- `-c {WORKDIR}` — 工作目录
- 最后一个参数包含 `claude --plugin-dir` 命令字符串

---

### TC11: WORKDIR 不存在 → mkdir -p 创建

**前置条件**：CC_WORKDIR 指向不存在的目录

**执行**：运行 bootstrap

**断言**：
- `mkdir -p "$WORKDIR/.claude"` 被调用
- 目录（含父目录）被递归创建
- 后续渲染步骤正常执行

---

### TC12: CC_PORT 自定义端口

**前置条件**：`CC_PORT=9999`

**执行**：运行 bootstrap

**断言**：
- `PORT` 变量 = `9999`
- settings.json 中所有 `__PORT__` → `9999`
- .mcp.json 中 awf-session 的 `AWF_BASE` = `http://127.0.0.1:9999`

---

### TC13: trust prompt 消除

**前置条件**：session 创建成功

**执行**：检查脚本尾部

**断言**：
- `sleep 3` — 等待 CC 启动
- `tmux send-keys -t "$SESSION" Enter` — 发送回车消除 trust prompt
- 不与 `-d` detached 模式冲突（send-keys 可在 detached session 执行）

---

### TC14: 特殊字符路径

**前置条件**：ROOT 路径包含空格（如 `/path/to/my project/cc-control`）

**执行**：运行 bootstrap

**断言**：
- 所有路径引用使用双引号 `"$ROOT/..."`（安全）
- sed 命令中的 `/` 分隔符可能被路径中的 `/` 干扰
- 实际上 sed 使用 `|` 分隔符：`sed "s|__TOOLS__|$ROOT/src/mcp|g"`（安全）
- 路径中的空格被双引号保护（`"$WORKDIR/.claude"`, `"$WORKDIR/.mcp.json"`）
- 模板文件 `mcp.json.template` 的单引号引用 `'__TOOLS__/awf-state/server.cjs'` 会保留空格语义

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| bootstrap.sh | 真实 bash 执行 + mock tmux/claude | 创建临时 tmux wrapper 脚本，验证调用参数 |
| tmux | PATH 注入 wrapper 脚本 | 记录调用参数到临时文件，用于断言验证 |
| claude | PATH 注入 wrapper 脚本 | 不真正启动 CC |
| sed 渲染 | 真实 sed | 验证替换结果 |
| filesystem | 临时目录 | 隔离测试环境 |
