# Bootstrap 模块 — 需求文档

> 源码文件：`scripts/bootstrap.sh` + `src/mcp/mcp.json.template` + `src/server/hooks/settings.json`

---

## 功能描述

`bootstrap.sh` 是 `awf run` 的 tmux 环境初始化脚本，负责：

1. **环境检查** — 验证 tmux 和 claude 可用
2. **配置渲染** — 将模板中的占位符替换为实际值
3. **tmux session 创建** — 启动带插件的 Claude Code 会话

---

## 1. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CC_SESSION` | `cc` | tmux session 名称 |
| `CC_WORKDIR` | `$ROOT/sandbox` | 工作目录（Claude Code 启动目录） |
| `CC_PORT` | `8787` | HTTP Session Server 端口 |
| `CC_PLUGIN_DIR` | `$ROOT/plugin` | 插件目录 |

---

## 2. 执行流程

```
bootstrap.sh
  ├─ 1. 获取 ROOT（脚本所在目录的父目录）
  ├─ 2. 读取环境变量（SESSION / WORKDIR / PORT）
  ├─ 3. 前置检查
  │    ├─ command -v tmux  → 不存在 → exit 1
  │    └─ command -v claude → 不存在 → exit 1
  ├─ 4. 渲染 settings.json
  │    └─ sed "s/__PORT__/$PORT/g" hooks/settings.json → .claude/settings.json
  ├─ 5. 渲染 .mcp.json
  │    └─ sed 三处替换 → .mcp.json
  ├─ 6. 检查 session 是否存在
  │    └─ 已存在 → echo + exit 0
  └─ 7. 创建 session
       ├─ tmux new-session -d -s $SESSION -x 200 -y 50 -c $WORKDIR
       │    "claude --plugin-dir $PLUGIN_DIR --permission-mode bypassPermissions"
       ├─ sleep 3
       └─ tmux send-keys Enter（消除 trust prompt）
```

---

## 3. 配置渲染

### settings.json 渲染

**模板**：`src/server/hooks/settings.json` → 输出：`{WORKDIR}/.claude/settings.json`

```bash
sed "s/__PORT__/$PORT/g" "$ROOT/src/server/hooks/settings.json" > "$WORKDIR/.claude/settings.json"
```

所有 `__PORT__` 被替换为实际端口号（如 `8787`）。

### .mcp.json 渲染

**模板**：`src/mcp/mcp.json.template` → 输出：`{WORKDIR}/.mcp.json`

| 占位符 | 替换为 | 使用位置 |
|--------|--------|---------|
| `__TOOLS__` | `$ROOT/src/mcp` | 3 个 server 的 `args` 路径 |
| `__WORKDIR__` | `$WORKDIR` | awf-state 的 `AWF_PROJECT_ROOT` |
| `__PORT__` | `$PORT` | awf-session 的 `AWF_BASE` |

渲染后配置 3 个 MCP server：

| Server | command | 环境变量 |
|--------|---------|---------|
| awf-state | `node {ROOT}/src/mcp/awf-state/server.cjs` | `AWF_PROJECT_ROOT={WORKDIR}` |
| awf-session | `node {ROOT}/src/mcp/awf-session/server.cjs` | `AWF_BASE=http://127.0.0.1:{PORT}` |
| awf-oneshot | `node {ROOT}/src/mcp/awf-oneshot/server.cjs` | —（无 env） |

---

## 4. tmux Session 管理

### 创建命令

```bash
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "claude --plugin-dir '$PLUGIN_DIR' --permission-mode bypassPermissions"
```

| 参数 | 含义 |
|------|------|
| `-d` | detached 模式 |
| `-s $SESSION` | session 名 |
| `-x 200 -y 50` | terminal 尺寸（宽 200 列，高 50 行） |
| `-c $WORKDIR` | 工作目录 |
| `--plugin-dir` | 加载本地插件 |
| `--permission-mode bypassPermissions` | 跳过所有权限确认 |

### Trust prompt 处理

```
sleep 3
tmux send-keys -t "$SESSION" Enter
```

`bypassPermissions` 下可能仍有 trust prompt，sleep 3 秒后发 Enter 消除。

### 已存在处理

```bash
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists."
  exit 0
fi
```

---

## 5. 依赖

| 模块 | 用途 |
|------|------|
| `tmux` | session 创建与管理 |
| `claude` | Claude Code CLI |
| `sed` | 模板占位符替换 |
| `bash` | 脚本运行时 |
