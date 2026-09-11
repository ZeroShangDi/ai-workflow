# Bootstrap 模块 — 功能文档

> 对应 WBS：
> 源码：`scripts/bootstrap.sh`
> 相关：`src/cli/server.js`（`server start` 在 session 不存在时调用）、`scripts/render-config.mjs`

## 功能描述

`bootstrap.sh` 是 `awf run` / `awf server start` 的 tmux 环境脚本，职责**只有两件**：

1. 环境检查（tmux / claude / node）；
2. 创建 tmux session 并启动 `claude`。

**bootstrap 不做任何配置渲染**：插件 / hooks / MCP 由项目 `.claude/settings.json` 注册加载（`awf init` 本地注入或全局 `claude plugin install`），项目级 `.mcp.json`（3 个 awf-* server）由 `awf init` / `awf run` 的 `installProjectMcp` 生成。`render-config.mjs` 的 `--workdir` 沙箱模式**不再由 bootstrap 触发**（手动调用）。

## 执行流程

```
bootstrap.sh
  ├─ DIR  = 脚本所在目录；ROOT = DIR 的父目录
  ├─ SESSION = ${CC_SESSION:-cc}
  ├─ WORKDIR = ${CC_WORKDIR:-$ROOT/sandbox}
  ├─ 前置检查
  │    command -v tmux   → 缺 → stderr「tmux not found...」+ exit 1
  │    command -v claude → 缺 → stderr「claude not found on PATH」+ exit 1
  │    command -v node   → 缺 → stderr「node not found on PATH」+ exit 1
  ├─ tmux has-session -t $SESSION ?
  │    存在 → echo "already exists" + exit 0
  └─ 创建 session
       ├─ 组装 ENV_ASSIGNS（见下）
       ├─ tmux new-session -d -s $SESSION -x 200 -y 50 -c $WORKDIR
       │    "env -u CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -u DISABLE_TELEMETRY \
       │       -u DO_NOT_TRACK -u DISABLE_GROWTHBOOK \
       │     $ENV_ASSIGNS claude --permission-mode bypassPermissions \
       │       --settings \"$WORKDIR/.awf/run-settings.json\""
       ├─ tmux set-option -t $SESSION history-limit 100000
       ├─ sleep 3
       └─ tmux send-keys -t $SESSION Enter（消除 trust prompt）
```

## 核心常量 / 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CC_SESSION` | `cc` | tmux session 名 |
| `CC_WORKDIR` | `$ROOT/sandbox` | Claude Code 启动目录（`-c`） |
| `CC_PROJECT` | （透传） | 本项目根；显式赋值，用于 hook `&p=` 路由与 MCP `AWF_PROJECT_ROOT` 回落 |
| `CC_PORT` | （透传） | server 端口 |
| `CC_AWF_STATE_SERVER` | （透传） | awf-state MCP 的 `PROJ_ROOT` 来源 |
| `CC_SID` | （透传） | run 标识 |
| `history-limit` | `100000` | tmux 回滚缓冲（`capture-pane -S -` 依赖） |

**run 级 env 显式赋值（T1-098）**：`CC_SESSION` / `CC_WORKDIR` 恒定写入 `ENV_ASSIGNS`；`CC_PROJECT` / `CC_PORT` / `CC_AWF_STATE_SERVER` / `CC_SID` 仅在调用进程已提供时追加（未提供不写空赋值）。原因：tmux 新会话进程拿到的环境来自 tmux **全局** env（启动 tmux server 那个 run 的环境），并发多 run 时会继承别项目的 `CC_PROJECT`，导致 hook 事件落错项目槽 / MCP 读写错项目 state。故一律在 `claude` 命令前显式赋值，不依赖 tmux 会话环境。

**`env -u`** 去掉 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_TELEMETRY` / `DO_NOT_TRACK` / `DISABLE_GROWTHBOOK`（telemetry / feature-flag 类），仅影响本 claude 会话。

**`--settings "$WORKDIR/.awf/run-settings.json"`** 挂载 run 级 settings（statusLine 等）。**插件不通过 `--plugin-dir` 加载**——三插件由项目 `.claude/settings.json` 注册。

## 函数清单

`bootstrap.sh` 为纯 bash 脚本，无导出函数；逻辑见上「执行流程」。被 `src/cli/server.js` 的 `serverCommand('start')` 以 `bash "<bootstrapScript>"` 调用（`tmux has-session` 失败时）。

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `tmux` | session 创建、`set-option`、`send-keys` |
| `claude` | Claude Code CLI（`--permission-mode bypassPermissions`） |
| `node` | 插件 MCP server 启动（须在 PATH 上） |
| `bash` | 脚本运行时 |
| `.awf/run-settings.json` | `--settings` 挂载（由 run 布局生成） |

## 验收标准

- [ ] tmux / claude / node 任一缺失 → exit 1 并给出对应 stderr
- [ ] session 已存在 → 输出 `already exists` + exit 0，不创建
- [ ] session 不存在 → `tmux new-session -d -s <SESSION> -x 200 -y 50 -c <WORKDIR>`，命令含 `claude --permission-mode bypassPermissions`，**不含** `--plugin-dir`
- [ ] bootstrap **不写** `.claude/settings.json` / `.mcp.json`（不覆盖项目注册）
- [ ] run 级 env 在 `claude` 前显式赋值；未提供的变量不写空赋值
- [ ] 尾部 `sleep 3` + `send-keys Enter` 消除 trust prompt
