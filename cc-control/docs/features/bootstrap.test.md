# Bootstrap 模块 — 测试用例文档

> 对应需求文档：`docs/features/bootstrap.md`
> 源码文件：`scripts/bootstrap.sh`
> 测试文件：`tests/integration/bootstrap.test.js`

---

## 测试场景总览

### 环境检查 — 3 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 1 | tmux 未安装 → exit 1 | 前置依赖 |
| 2 | claude 未安装 → exit 1 | 前置依赖 |
| 3 | node 未安装 → exit 1（MCP server 需要） | 前置依赖 |

### 配置加载 — 1 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 4 | 不渲染 settings.json/.mcp.json — 不覆盖项目注册 | 结构 |

### Session 管理 — 4 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 5 | session 不存在 → 创建（claude 无 `--plugin-dir`） | 正常 |
| 6 | session 已存在 → exit 0 不创建 | 正常 |
| 7 | CC_SESSION 环境变量 → 自定义名称 | 环境变量 |
| 8 | tmux new-session 参数验证 | 参数 |

### 边界 — 1 个 TC

| # | 场景 | 类别 |
|---|------|------|
| 9 | trust prompt 消除（sleep 3 + send-keys Enter） | 正常 |

---

## 详细测试用例

### TC1: tmux 未安装 → exit 1

**前置条件**：tmux 不在 PATH 中（PATH 仅含 tmux 缺失的 stub bin）

**执行**：`bash scripts/bootstrap.sh`

**断言**：
- stderr 输出 "tmux not found. Install with: brew install tmux"
- 退出码 1
- 不执行后续 session 创建

---

### TC2: claude 未安装 → exit 1

**前置条件**：tmux 可用，claude 不在 PATH 中

**执行**：`bash scripts/bootstrap.sh`

**断言**：
- stderr 输出 "claude not found on PATH"
- 退出码 1
- tmux session 未创建

---

### TC3: node 未安装 → exit 1

**前置条件**：tmux、claude 可用，node 不在 PATH 中

**执行**：`bash scripts/bootstrap.sh`

**断言**：
- stderr 输出 "node not found on PATH"
- 退出码 1
- 原因：插件 MCP server 需 node 启动

---

### TC4: 不渲染 settings.json/.mcp.json — 不覆盖项目注册

**前置条件**：正常执行环境

**执行**：运行 bootstrap

**断言**：
- 退出码 0
- `.claude/settings.json` 未被写入（`fs.existsSync` 为 false）
- `.mcp.json` 未被写入（`fs.existsSync` 为 false）
- 插件/hooks/MCP 由项目 `.claude/settings.json` 注册加载，bootstrap 不再写任何文件

---

### TC5: session 不存在 → 创建（claude 无 `--plugin-dir`）

**前置条件**：tmux session `cc` 不存在（STUB_HAS_SESSION=0）

**执行**：运行 bootstrap（mock tmux/claude）

**断言**：
- `tmux has-session -t cc` 被调用
- `tmux new-session -d -s cc -x 200 -y 50 -c {WORKDIR}` 被调用
- 命令含 `claude --permission-mode bypassPermissions`
- 命令**不含** `--plugin-dir`（插件由 settings.json 注册加载）

---

### TC6: session 已存在 → exit 0 不创建

**前置条件**：tmux session `cc` 已存在（STUB_HAS_SESSION=1）

**执行**：`bash scripts/bootstrap.sh`

**断言**：
- 输出 "tmux session 'cc' already exists"
- 退出码 0
- `tmux has-session -t cc` 被调用
- `tmux new-session` 未被调用

---

### TC7: CC_SESSION 环境变量 → 自定义名称

**前置条件**：`CC_SESSION=my-workflow`

**执行**：运行 bootstrap

**断言**：
- `tmux has-session -t my-workflow` 被调用
- `tmux new-session -d -s my-workflow` 被调用

---

### TC8: tmux new-session 参数验证

**前置条件**：mock tmux，CC_SESSION=cc，默认参数

**执行**：提取 `tmux new-session` 调用行

**断言**：
- `-d` — detached 模式
- `-s cc` — session 名称
- `-x 200 -y 50` — terminal 尺寸固定
- `-c {WORKDIR}` — 工作目录
- 不含 `--plugin-dir`

---

### TC9: trust prompt 消除

**前置条件**：session 创建成功

**执行**：检查脚本尾部

**断言**：
- `tmux send-keys -t cc Enter` 被调用
- 脚本源码含 `sleep 3`（等待 CC 启动后发回车消除 trust prompt）

---

## Mock 策略

| 模块 | 方式 | 说明 |
|------|------|------|
| bootstrap.sh | 真实 bash 执行 + mock tmux/claude/node/sleep | PATH 注入 stub wrapper，记录调用参数到日志文件 |
| tmux | PATH 注入 wrapper 脚本 | 记录调用参数（has-session / new-session / set-option / send-keys），STUB_HAS_SESSION 控制存在性 |
| claude | PATH 注入 wrapper 脚本 | 不真正启动 CC |
| node / sleep | PATH 注入空转 stub | node 仅满足前置检查；sleep 消除等待 |
| filesystem | 临时目录 | 隔离测试环境（stub.log / workdir） |
