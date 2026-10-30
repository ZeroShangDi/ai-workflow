# DSH 隔离探针（AWF × DSH 实验夹具）

> P0 的同类夹具曾放在 `.awf/probe/dsh/`（`.awf/` 被 gitignore）——**换机时丢了，只剩记忆**。
> P2-3 重建时改放 `scripts/probe/dsh/`，**纳入 git**：夹具是可复现证据的一部分，不该随 `/tmp` 消失。

## 它是干什么的

在不触碰用户真实 `~/.dsh` 的前提下，把 DSH 的平台能力逐项测出来，供 AWF 的 DSH 适配器
（`server/adapters/dsh/`）照着实测结果写，而不是照着猜。

## 四条纪律（每次实验都要守）

1. **只碰隔离 home**：`DSH_HOME=/tmp/awf-dsh-probe`（`env.sh` 会强制并在指向真实 home 时报错）。
2. **实验静默**：`dsh web --no-open`，绝不弹浏览器。
3. **证据分类**：静态核查 / 替身测试 / **真实运行** 三类分开说；「假件通过」≠「DSH 可用」。
4. **零副作用可证**：实验前 `guard.sh snapshot`，实验后 `guard.sh check` 必须 `IDENTICAL`。

## 怎么跑

```bash
cd <repo>/cc-control

# ① 实验前记指纹（真实 ~/.dsh 的配置面）
bash scripts/probe/dsh/guard.sh snapshot

# ② 离线装配探针 profile（本机无 pnpm，不用 `dsh plugin add`，见 F13）
#    装入两个插件：探针夹具 + AWF 的 DSH host 半侧（dsh-plugin/，符号链接）
bash scripts/probe/dsh/install-fixture.sh

# ③ 指令通道真实链路验证（起隔离 AWF + 隔离 DSH，断言回执；不派模型）
node scripts/probe/dsh/roundtrip.cjs

# ④（可选）手动起探针后台看页面/打路由
bash scripts/probe/dsh/serve.sh start
bash scripts/probe/dsh/serve.sh wait      # 输出 [serve] ready + 带 token 的 URL
URL="$(bash scripts/probe/dsh/serve.sh url)"
curl -sS -c /tmp/awf-probe-cookie "$URL" -o /dev/null            # 用 token 换 cookie
curl -sS -b /tmp/awf-probe-cookie "http://127.0.0.1:${AWF_PROBE_WEB_PORT:-39081}/api/awf-probe/ping"
bash scripts/probe/dsh/serve.sh stop

# ⑤ 收尾（必做）
bash scripts/probe/dsh/guard.sh check     # 必须 IDENTICAL
```

## 目录

```
scripts/probe/dsh/
  env.sh                强制 DSH_HOME + 防呆 + 端口/profile/凭据符号链接
  guard.sh              真实 ~/.dsh 配置面指纹（snapshot|check）
  install-fixture.sh    离线装配：建 profile + 符号链接两个插件 + 写 patch 层
  serve.sh              静默起停（start|wait|stop|url）
  roundtrip.cjs         指令通道真实链路验证（模式：默认/prompt/task/bash/plan/oneshot/runtime/run/
                        two-projects/subagent/batch/decision/attach/cli-plan）
  cli-install.cjs       CLI 装配路径（`awf plugin install`；`--init` = 干净项目 `awf init` 幂等）
  fixtures/probe-plugin/ 探针夹具（Cordis host 半侧：HTTP 路由 ping/services）
dsh-plugin/             AWF 的 DSH host 半侧（生产插件；profile 里符号链接装入）
```

## 重建时最容易踩的坑（F 表）

1. 插件运行期装配必须放 `ctx.inject([...services], cb)`；放 `apply` 顶层或 `setTimeout` 之后都会命中非活动上下文（F25）。
2. `sessionController.prompt(request, signal)` 的 **signal 是第二位置参数**（F26）。
3. MCP 工具注册**异步**：挂载后立刻提问会看到「没有该工具」，派发前必须等注册（F29）。
4. 判定「工具是否可用」看 `session.requestHeader().tools`，不要用 `agent.ctx.tools.get`（F30）。
5. `workspace-write` 等 preset 的贡献在 **agent 平面的 isolate realm**，root ctx / `agent.ctx` 都可能取不到（F32/F35）。
6. include patch 的 `config` 是**浅覆盖**：覆盖 `webserver` 必须给全 `host`（F14）。
   本夹具改用 CLI 的 `--port/--host`，绕开这条坑。
7. 批准策略只有 `ask` / `never`，且 `never` 是**自动拒绝**；`workspace-write` 预设的 approval 是 `ask`
   —— 受控自动批准要走 `approval/request` 应答者缝（见执行记录 §2.5）。
8. `dsh web` 是 `--profile web` 的**别名**，不接受父级 `--profile`：自定义 profile 必须写
   `dsh --profile awf-probe --port … --no-open`（F37）。
9. **插件路由不在 dsh 的浏览器信任栅栏内**（F36）：实测同实例 `/`=401、`/api`=401、`/api/sessions`=401，
   而 `/api/awf-probe/ping`=**200**。所以探针/产品入口都要**自己做鉴权**；
   「注册在 `/api` 下就受保护」是错的。

## 实测记录（2026-09-19，P2-3 验收）

```
[guard] snapshot -> ... (193 lines)
[serve] ready  url=http://127.0.0.1:39081/?token=…
GET /api/awf-probe/ping      -> 200 {"ok":true,"plugin":"awf-probe-plugin","dshHome":"/tmp/awf-dsh-probe",…}
GET /api/awf-probe/services  -> 501 {"ok":false,"error":"services listing not available on this build",…}
GET / /api /api/sessions     -> 401 ; GET /nonexistent-xyz -> 404
[guard] check -> IDENTICAL（真实 ~/.dsh 配置面零改动）
```

## 实测记录 · 指令通道真实链路（2026-09-19，P2-5a）

```
$ node scripts/probe/dsh/roundtrip.cjs
[roundtrip] AWF server 起于 http://127.0.0.1:55973（隔离临时项目）
[roundtrip] ✓ 插件已连上（platform=dsh, pluginVersion=0.0.1）
[roundtrip] ✓ session.facts 回执：{"sessionExists":false,"reachable":true,"ready":false,…}
             → delivery=accepted, ok=true
[roundtrip] ✓ 未实现 op 明确失败：op "session.create" 尚未实现（P2-5b）…
             → delivery=accepted, ok=false
[guard] check -> IDENTICAL
```

要点：facts 来自**平台真实现场**（隔离 home 里确实没有会话，故 `sessionExists:false`）；
未实现的 op 走的是「已交给平台 + 明确失败」，不是假装成功。

## 实测记录 · 会话创建/停止（2026-09-19，P2-5b 第一段，未派模型）

```
✓ 会话已创建：session-118c8852-…（preset=standard）
✓ facts 已反映该会话（sessionExists=true, cwd=<临时项目>）
✓ 已停止且会话仍在（cancel keepInbox，未删会话）
[guard] check → IDENTICAL
```

注意：`stop` 之后 `sessionExists` 仍为 true 是**期望**的 —— 停止 ≠ 删除（spec §2：
停项目不停共享后台、不删对话记录）。要删会话是另一件事，本轮不做。

## 实测记录 · 真派一轮模型（2026-09-19，P2-5c）

```
$ node scripts/probe/dsh/roundtrip.cjs --prompt "只回复两个字：收到。不要调用任何工具。"
✓ 平台已受理（accepted=true）；等回合结束…
✓ 回合结束：events=["turn.started","prompt.submitted","session.ready"]
   → session.facts(回合结束后).ready === true
[guard] check → IDENTICAL
```

**要点**：`accepted=true` 只是「平台受理」；这一轮真正结束的证据是 `session.ready`（来自 `turn/end`）。
`--prompt` 是**可选**参数：不带它整轮不派模型（省额度）。

## 实测记录 · 会话级挂 MCP + 真落账（2026-09-19，P2-5d）

```
$ node scripts/probe/dsh/roundtrip.cjs --task
✓ 会话已创建：session-7c7e13e2-…（preset=default，含模型选择 + preset + 项目 MCP）
✓ 平台已受理（accepted=true）；等回合结束…
✓ 回合结束：events=["turn.started","prompt.submitted","session.ready"]
✓ MCP 工具已进可见工具表：20 个 mcp__awf-state__*（read_state / task_complete / dynamic_plan …）
✓ 经 AWF MCP 工具真落账：T1.status=done（磁盘 state.json 的 exec.completedAt 已写）
[guard] check → IDENTICAL
```

**两条踩过的坑（写进坑位清单）**：MCP 必须在 **agent 发布前**的 `setup` 里挂（`sessionController.create`
没有这个窗口，挂上去工具进不了工具表）；`session.requestHeader().tools` 是事件折叠，**首次模型请求前恒为空**，
所以「建会话时等工具注册」不可行 —— 核对点放在首次派发之后（`session.tools` 指令）。

## 实测记录 · 快照与 U16 批准取证（2026-09-19，P2-5e 第一段）

```
$ node scripts/probe/dsh/roundtrip.cjs --bash
✓ 快照："<模型 bash pwd 的真实输出>"
✓ 本轮无批准请求（workspace-write 下的普通 bash 不需要批准）

$ node scripts/probe/dsh/roundtrip.cjs --task
✓ 快照："DONE"  ✓ 20 个 mcp__awf-state__* 进工具表  ✓ T1.status=done
```

**U16 结论**：`workspace-write` 预设下**项目内**操作由沙箱 auto-allow，**不会**请求批准；只有越出沙箱的
操作才需要批准。所以「项目范围内自动批准」不需要额外规则，保持「只记录 + 委派」即可（项目外 fail closed）。

## 实测记录 · 规划入口与一次性调用（2026-09-19，P2-5f）

```
$ node scripts/probe/dsh/roundtrip.cjs --plan --oneshot
✓ 规划会话已建并注入指令：session-3f50add8-… url=http://127.0.0.1:39081/?session=…
✓ 一次性调用返回文本："OK"（未建会话）
[guard] check → IDENTICAL
```

两个实测踩点（都写进了坑位清单）：`llm.stream` 的 `messages` 必须用平台 `createUserMessage` 构造
（裸 `{role,content}` → `content.some is not a function`）；文本只认 `text-delta`，叠加 `block-end` 会算两遍。

## 实测记录 · 单任务 run（2026-09-19，P2-6b）—— P2 出口条件

```
$ node scripts/probe/dsh/roundtrip.cjs --run
✓ 会话已创建：session-3ad3adf4-…
✓ run 宿主单任务跑通：run=done T1=done
[guard] check → IDENTICAL
```

## 实测记录 · P3/P4（2026-09-19）

```
$ node scripts/probe/dsh/roundtrip.cjs --subagent   # 子 Agent 真派出 + RESULT 落账 + 停 run 逐个打断
✓ 子 Agent 已派发：1 个（…）
✓ 子 Agent 结果已落账：T2.status=done result=subagent-settle-smoke
✓ 生命周期已留档：["SubagentStart","SubagentStop"]
✓ 停 run 时逐个打断子 Agent：["…"]

$ node scripts/probe/dsh/roundtrip.cjs --batch      # 多 agent：宿主 batch 调度（平台化派发提示词）
✓ batch 多 agent 跑通：run=done T1=done（子 Agent 事件 ["SubagentStart","SubagentStop"]）

$ node scripts/probe/dsh/roundtrip.cjs --decision   # 回合末门阀：指令发回会话 → 决策结论落盘
✓ 回合末门阀跑通：决策结论已落盘（D-mu8ai9gc-1）
   events=["turn.started","prompt.submitted","session.ready"]×2

$ node scripts/probe/dsh/roundtrip.cjs --attach     # awf attach（独立 CLI 进程）拿会话地址
✓ `awf attach`（独立进程）拿到会话地址：…:39081/?session=…

$ node scripts/probe/dsh/roundtrip.cjs --cli-plan   # awf plan（独立 CLI 进程）经 server 代触发
✓ `awf plan`（独立进程）经 server 触发规划入口（输出含网页会话地址）

$ AWF_ROUNDTRIP_RECONNECT=1 node scripts/probe/dsh/roundtrip.cjs   # 重启 DSH → 重连且通道仍可用（F44）
✓ 重启后已重连，且通道真的可用（sawDown=true）

$ node scripts/probe/dsh/cli-install.cjs --pack     # 发布包在新目录里安装/卸载
✓ 发布包含 DSH 插件半侧（4 项抽查齐备）
✓ 包内 CLI 在新目录装配成功，插件落在隔离 home
✓ 包内源码不含开发机绝对路径
```

**为什么 attach/plan 要独立进程跑**：CLI 进程里**没有 bridge**（bridge 只在常驻 server 里）。
平台侧动作能由 server 代触发的走 HTTP 面（`POST /interactive/plan`），必须在用户终端里的留在
CLI 进程（cc 的交互式对话）—— 判据是平台声明的 `interactive.detached`（F41）。

## 实测记录 · 双项目隔离（2026-09-19，P2-6d）

```
$ node scripts/probe/dsh/roundtrip.cjs --two-projects
两个项目各建会话：A=dsh B=dsh
✓ 双项目隔离：A→"0.2.0|T-A" B→"9.9.9|T-B"
✓ 停 A 不影响 B（单后台、多项目各自独立）
[guard] check → IDENTICAL
```

**本轮抓到的缺陷**：首跑两边快照都为空 —— `host.sendPrompt` 没带 `projectRoot`，插件回落到「第一个会话」，
两个项目的指令打到同一处。DSH 的指令通道是**进程级共享**的，每条指令都必须带项目身份。

## 实测记录 · CLI 装配路径（2026-09-19，P2-6c）

```
$ node scripts/probe/dsh/cli-install.cjs
✓ CLI 已装配：已装配 DSH profile awf-cli → …/cordis.patch.yml
✓ dsh --dump-config 含 awf-dsh-plugin
✓ 卸载后 dump-config 不再含该插件，用户注释仍在
[guard] check → IDENTICAL
```

### `--init`：干净项目上的 `awf init`（V01 前半）

```
$ node scripts/probe/dsh/cli-install.cjs --init
✓ `awf init` 在 DSH 项目上跑通（前置检查 ✓ dsh / ✓ node + 建骨架）
✓ 骨架齐（5 项）+ 平台已记入 .awf/config.json（adapter=dsh）
✓ 重复 init 幂等（含不带 CC_ADAPTER 时仍是 dsh）：标记块仍 1 处、备份未覆盖、state.json 与用户 README 未被冲
✓ `awf init --force` 只补缺失目录，state.json 与装配块不受影响
✓ 卸载后 patch 复原（用户注释仍在）
```

干净项目上平台只能靠 `CC_ADAPTER=dsh` 声明（`.awf/` 还没有）。这一跑抓到两个真缺陷：
`awf init` 不把解析到的平台记进 `.awf/config.json`（模板缺省写 cc → 项目解析回 cc），
以及 `localPlugin` 里写死的 `buildContext(root, { env: {} })` 把 `CC_ADAPTER` 一起吞掉
（结果按 cc 注册，profile 根本没装）。

要点：装配写的是**用户级 profile**（全局一次、多项目共享）；**DSH 自己 dump 得出来**才算装对；
幂等 + 备份 + 卸载只摘自己的标记块，用户原有内容一个字不动。

**这次真运行打到一处 P1 回归**：首跑 `run=error "sleep is not defined"` —— T-P1-02 删掉了 executor 顶部的
`sleep` 助手，而结算循环仍在用（**CC 的真实单 agent 路径同样已被打断**）。假执行器的集成用例证明不了
真 executor 能跑；修好后新增 `tests/unit/executor-settle.test.js` 直接驱动真实 executor 跑结算循环。
