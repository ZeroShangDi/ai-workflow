# run 会话环境继承 tmux 全局 env：并发多 run 时串项目（hook 路由错槽 / MCP 读写错 state）

- 状态: fixed（2026-09-10，T1-098 真 run 全流程回归暴露）
- 类型: awf 产品缺陷（多 run 隔离 / 会话环境装配）
- 关联: W3-006（多 run sessionid 贯穿·同机并发隔离）、T1-098（真 run 回归）、`scripts/bootstrap.sh`、`plugin/core/hooks/gateway.cjs`、`plugin/core/mcp/awf-state/server.cjs`

## 现象

沙箱项目真 run（T1-098 回归）第 2 个任务派发时失败，run 异常终止：

```
  ── 任务 T1: 创建 src/counter.js ──
     T1              ✔ done
  ── 任务 T2: 审查 T1 产出 ──
                     ✘ run default 异常：still busy (ready timeout)
     run             • 已停止（error）
```

同一 run 内 claude 会话自身也报告：插件自带的 `ai-workflow-core:awf-state` MCP 读到的是**另一个项目**的
state（返回了本项目不存在的 `T1-001 config-loader` 等任务）。

## 根因

`src/cli/run.js` 的 `ensureSession` 已把 run 环境（`CC_WORKDIR/CC_SESSION/CC_PROJECT/CC_AWF_STATE_SERVER/CC_PORT`）
显式传给 `scripts/bootstrap.sh`；但 bootstrap 只把 **`CC_SESSION`** 显式套在 claude 命令前，其余变量没有下发。

tmux 新建会话里进程拿到的环境**不是**调用 `bootstrap.sh` 那个进程的环境，而是 tmux **全局 env**
（= 当初启动 tmux server 的那个 run 的环境）。于是并发多 run / 机器上残留别项目会话时，本 run 的 claude
继承到**别的项目**的 `CC_PROJECT`（以及 `CC_WORKDIR/CC_PORT/CC_AWF_STATE_SERVER`）。两处后果：

1. **hook 路由错槽**：`plugin/core/hooks/gateway.cjs` 按 `process.env.CC_PROJECT` 组 `&p=`，
   server `/hook` 据此定位项目槽 → 本 run 的 `SessionStart/Stop` 全落到别人的槽，
   本 run 槽永远收不到就绪/结束事件 → 第二次派发 `waitReady` 超时（`still busy (ready timeout)`）→ run 异常终止。
2. **MCP 读写错项目**：插件级 `awf-state` MCP 的 `PROJ_ROOT = AWF_PROJECT_ROOT || CC_PROJECT`，
   `CC_AWF_STATE_SERVER=1` 时它按 `&p=PROJ_ROOT` 代理到 server → 读到/写到别人的项目 state。

为何单任务 run 与「两 run 各一个任务」的双 run 冒烟没暴露：这两类场景**只派发一次**，
槽在首次派发前是 ready，之后不再需要 ready 信号；缺陷要等到**同一 run 内第二次派发**才现形。

## 现场证据（2026-09-10，真 tmux + 真 claude + 真 server）

| 证据 | 值 |
|---|---|
| run 会话 tmux session | `cc-pbe863722be49`（沙箱 gate 项目，cwd 正确） |
| 该会话 claude 进程 env | `CC_SESSION=cc-pbe863722be49`（对）、`CC_PROJECT=/Users/…/cc-control`（**错，父 run 的项目**）、`CC_WORKDIR` 同错 |
| `tmux show-environment -g` | 只有父 run 的 `CC_PROJECT=/Users/…/cc-control` 等；session 级无覆盖 |
| `GET /status?p=<沙箱 gate>` | `sessionSeq: 0`（从未收到 SessionStart/Stop），`state: busy`（卡死） |
| `GET /status?p=<cc-control>` | `sessionSeq: 3`（沙箱会话的 hook 全落到这里） |
| 代码 | `bootstrap.sh` 命令行只含 `CC_SESSION="$SESSION"`；`gateway.cjs:32` `P_QS = CC_PROJECT ? '&p=' + CC_PROJECT : ''`；`awf-state/server.cjs` `PROJ_ROOT = AWF_PROJECT_ROOT \|\| CC_PROJECT \|\| ''` |

## 修复

`scripts/bootstrap.sh`：run 级变量一律显式赋值到 claude 命令前（与既有 `CC_SESSION` 同一机制），
不再依赖 tmux 会话环境：

```bash
ENV_ASSIGNS="CC_SESSION=\"$SESSION\" CC_WORKDIR=\"$WORKDIR\""
if [ -n "${CC_PROJECT:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_PROJECT=\"$CC_PROJECT\""; fi
if [ -n "${CC_PORT:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_PORT=\"$CC_PORT\""; fi
if [ -n "${CC_AWF_STATE_SERVER:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_AWF_STATE_SERVER=\"$CC_AWF_STATE_SERVER\""; fi
if [ -n "${CC_SID:-}" ]; then ENV_ASSIGNS="$ENV_ASSIGNS CC_SID=\"$CC_SID\""; fi
```

未提供的变量不写空赋值（空 `CC_PROJECT` 会让 MCP 退回 cwd/默认项目，反而更隐蔽）。
`src/server/session-launch.cjs` 是同一语义的纯构建版（`buildSessionEnv` 已注入 CC_PROJECT/CC_SID），
但 live 路径仍是 `bootstrap.sh`；本轮按最小改动只补 bootstrap，未做 live 切换。

## 验证

- `tests/integration/bootstrap.test.js` TC10/TC11：断言 tmux `new-session` 命令行携带
  `CC_SESSION/CC_WORKDIR/CC_PROJECT/CC_PORT/CC_AWF_STATE_SERVER`，且未提供的变量不出现空赋值。
- `tests/sandbox/fullflow-regression.mjs` 新增「run 会话 env 指向本项目」检查（取 tmux pane 进程 env，
  与 `ensureSession` 同用 realpath），dual 另加「两 run 会话 env 不串（CC_PROJECT 互异）」。
- 修复后真 run 重跑：single/gate 全绿（修复前 gate 卡在第二次派发的 `still busy (ready timeout)`）。
- 全量 `npm test`：102 文件 / 858 例绿。
