# Bootstrap 模块 — 需求文档

> 源码文件：`scripts/bootstrap.sh`。插件/hooks/MCP 由项目 `.claude/settings.json` 注册加载（`awf init` 本地注入 / 全局 `claude plugin install`），项目级 `.mcp.json`（3 个 awf-* server 绝对路径）由 `installProjectMcp` 生成——bootstrap 不参与任何配置渲染。

---

## 功能描述

`bootstrap.sh` 是 `awf run` 的 tmux 环境初始化脚本，负责：

1. **环境检查** — 验证 tmux、claude、node 可用
2. **tmux session 创建** — 以 bypassPermissions + 固定 messaging socket + 会话级 run-settings 启动 Claude Code

---

## 1. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CC_SESSION` | `cc` | tmux session 名称 |
| `CC_WORKDIR` | `$ROOT/sandbox` | 工作目录（Claude Code 启动目录） |
| `CC_MESSAGING_SOCKET` | `$WORKDIR/.awf/messaging.sock` | inbox socket 固定路径（CLI 用同一路径注入派生指令） |

---

## 2. 执行流程

```
bootstrap.sh
  ├─ 1. 获取 ROOT（脚本所在目录的父目录）
  ├─ 2. 读取环境变量（SESSION / WORKDIR / MESSAGING_SOCKET）
  ├─ 3. 前置检查
  │    ├─ command -v tmux   → 不存在 → exit 1
  │    ├─ command -v claude → 不存在 → exit 1
  │    └─ command -v node   → 不存在 → exit 1（插件 MCP server 需 node）
  ├─ 4. 检查 session 是否存在
  │    └─ 已存在 → echo + exit 0
  └─ 5. 创建 session
       ├─ tmux new-session -d -s $SESSION -x 200 -y 50 -c $WORKDIR
       │    "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY \
       │       -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK \
       │     claude --permission-mode bypassPermissions \
       │       --messaging-socket-path $MESSAGING_SOCKET \
       │       --settings $WORKDIR/.awf/run-settings.json"
       ├─ tmux set-option history-limit 100000（防长会话被截断）
       ├─ sleep 3
       └─ tmux send-keys Enter（消除 trust prompt）
```

---

## 3. 配置加载

**插件 + hooks + MCP 不再由 bootstrap 渲染**。`awf init` 已完成：

- `.claude/settings.json` 注册双插件（core + plugin-code），hooks/MCP 随插件声明加载
- 项目级 `.mcp.json` 由 `installProjectMcp` 合并 3 个 awf-* server（绝对路径，指向 `plugin/core/mcp/awf-{state,session,oneshot}/server.cjs`），是 MCP 工具在 awf run 会话中可用的必要条件
- `.awf/run-settings.json` 提供 `crossSessionInbound: accept`（多 agent 滑动窗口 inbox 注入需要）+ statusLine（`scripts/context-usage.mjs`）

bootstrap 启动 claude 时通过 `--settings` 挂载 run-settings、`--messaging-socket-path` 固定 inbox socket，`env -u` 去掉会关闭 cross-session messaging 的变量（telemetry/feature-flag 类），仅影响本 claude 会话。

启动命令完整形态：

```bash
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK claude --permission-mode bypassPermissions --messaging-socket-path \"$MESSAGING_SOCKET\" --settings \"$WORKDIR/.awf/run-settings.json\""
```

---

## 4. tmux Session 管理

### 创建命令

```bash
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" \
  "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK claude --permission-mode bypassPermissions --messaging-socket-path \"$MESSAGING_SOCKET\" --settings \"$WORKDIR/.awf/run-settings.json\""
```

| 参数 | 含义 |
|------|------|
| `-d` | detached 模式 |
| `-s $SESSION` | session 名 |
| `-x 200 -y 50` | terminal 尺寸（宽 200 列，高 50 行） |
| `-c $WORKDIR` | 工作目录 |
| `--permission-mode bypassPermissions` | 跳过所有权限确认 |
| `--messaging-socket-path $MESSAGING_SOCKET` | 固定 inbox socket 路径（CLI 注入派生指令） |
| `--settings .awf/run-settings.json` | crossSessionInbound: accept + statusLine |
| `env -u ...` | 去掉关闭 cross-session messaging 的 telemetry/feature-flag 变量 |

> 注：插件不再通过 `--plugin-dir` 加载——双插件由项目 `.claude/settings.json` 注册（`awf init` 本地注入 / 全局 `claude plugin install`）。

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
| `node` | 插件 MCP server 启动（须在 PATH 上） |
| `bash` | 脚本运行时 |
