# DSH 接入：换机接续上下文（cross-machine handoff）

> 目的：**换一台电脑也能在 15 分钟内接着干**。本文件是唯一的「新机器上手」入口；
> 细节在执行记录，设计在执行 spec，用户取舍在 Codex 清单。三份文件的分工见 §2。
> 最后更新：2026-09-18（P0 收尾、U16/U17 确认后）。

---

## 0. 30 秒摘要

- 任务：按已确认 spec 把 AWF（ai-workflow）接入 DSH，覆盖全七命令，P0→P4 分阶段推进。
- **当前阶段：P0 基本完成**（9/10 实验有真实运行证据）；**下一步进入 P1（CC 契约收口）**。
- 已完成并验证：插件加载、会话级 MCP 多项目隔离、worker 权限边界（U15 已定）、decision 护栏、
  单任务真实落账、一次性隔离调用、取消/父子停止语义、UI 入口可执行。
- **两个待接线项**（已有确认结论，属 P2 实现）：`approval` 受控自动批准（U16）、上下文清空用「换新会话+交接」（U17）。
- P0 全程遵守：不越权动用户真实 `~/.dsh`、CC 路径保持可用、实验静默运行（`--no-open`）。

---

## 1. 新机器 15 分钟启动清单

```bash
# ① 取仓库（分支 feature/cc-control-v0.2.0）
cd <你的仓库父目录>
git pull                      # 或 clone 后切到 feature/cc-control-v0.2.0

# ② 关键：把未提交的 P0 产出带过来（见 §3 的「必须先做」）
#    若上一台机器已按 §3 提交/打包，这步跳过

# ③ 装依赖并验证基线
cd cc-control
npm install
npm test                      # 期望 107/108 文件、1005/1009 用例通过（唯一失败见下）
npm run check:capability      # 期望 ✓ 对账通过
npm run check:arch            # 期望 结构门禁通过

# ④ 造隔离实验环境（不要用真实 ~/.dsh！）
export AWF_DSH_PROBE_HOME=/tmp/awf-dsh-probe
mkdir -p "$AWF_DSH_PROBE_HOME"
#   真实 home 里已有的包可供复用（离线）：
export NODE_PATH="$HOME/.dsh/profiles/node_modules"
#   凭据：符号链接进隔离 home（不读、不打印、不复制内容）
ln -sfn "$HOME/.dsh/.credentials.yaml" "$AWF_DSH_PROBE_HOME/.credentials.yaml"

# ⑤ 起静默探针后台（不弹浏览器）
bash .awf/probe/dsh/serve.sh start
sleep 25
bash .awf/probe/dsh/serve.sh wait    # 输出 [serve] ready
```

**已知的预期失败（不是你的环境坏了）**：`tests/unit/init.test.js` 有 4 例失败，原因是该机器 PATH 上没有 `claude`
（该文件第一例就叫「本机三项齐备（真机用例的前置条件）」）。有 `claude` 的机器上应通过。

---

## 2. 文档分工（先读哪个）

| 文件 | 作用 | 何时读 |
|---|---|---|
| **本文件** | 换机上手、环境、未提交产出、下一步 | **先读这个** |
| `docs/discuss/dsh-adapter-execution.md` | 执行记录：任务板、每项验收、证据、**F01～F35 发现表**、变更日志 | 干活时随时查 |
| `docs/discuss/dsh-adapter-design-codex.md` | 设计 spec：§8 是 **X1～X9 的 P0 实测结论表**；§7 是 P0～P4 | 需要设计依据时读 |
| `docs/discuss/dsh-adapter-checklist-codex.md` | 用户取舍清单：U1～U17（**U15/U16/U17 是本轮新增并已确认**） | 拿不准是否已决策时读 |
| `CLAUDE.md`（仓库根 cc-control/） | 项目结构与开发规范 | 第一次接触仓库时读 |

**历史文档**（设计依据追溯用，不要当当前状态）：`dsh-adapter-checklist.md`、`dsh-adapter-design.md`（DS 原始稿）。

---

## 3. 必须先做：把未提交的 P0 产出带过去

这些文件**当前未提交**，直接换机器会丢失。二选一：

**方案 A（推荐）：提交到分支**
```bash
cd <repo>/cc-control
git add docs/discuss/dsh-adapter-design-codex.md \
        docs/discuss/dsh-adapter-execution.md \
        docs/discuss/dsh-adapter-checklist-codex.md \
        scripts/check-capability.mjs \
        server/adapters/capability-registry.json \
        tests/unit/capability-registry.test.js \
        package.json
git commit -m "feat(cc-control): DSH 接入 P0 —— 9 项关键能力实测 + 能力登记对账（U9）"
```
（`package.json` 只加了一行 script `check:capability`，无依赖变化。）

**方案 B：打包带走（不动 git 历史）**
```bash
cd <repo>/cc-control
tar czf /tmp/awf-dsh-p0.tar.gz \
  docs/discuss/dsh-adapter-{design,execution,checklist}-codex.md \
  scripts/check-capability.mjs server/adapters/capability-registry.json \
  tests/unit/capability-registry.test.js package.json .awf/probe
# 目标机器解开覆盖即可
```

⚠️ **实验夹具 `.awf/probe/` 不在 git 里**（`.awf/` 部分被忽略）。它包含全部探针脚本与插件夹具，
**是复跑 P0 实验的唯一途径**。请务必按方案 B 一起打包（或在目标机器按 §5 重建）。

---

## 4. 环境事实（换机后需重新确认的点）

| 项 | 本机（P0 验证基线） | 换机后要做什么 |
|---|---|---|
| DSH 版本 | **0.1.5-rc.2**（launcher 与内部包一致） | `dsh --version` 确认；版本不同则 X 结论需复核 |
| 用户真实 DSH home | `~/.dsh`，**有正在运行的 `dsh web`（127.0.0.1:3080）** | **绝对不要动它**；实验一律用隔离 `DSH_HOME` |
| 隔离实验 home | `/tmp/awf-dsh-probe` | 换机重建（§1 第 ④ 步）；`/tmp` 重启会清空 |
| 实验端口 | `39081`（探针）/ `3080`（用户） | 39081 被占则改 `.awf/probe/dsh/patches/port-39081.yml` 与 `serve.sh` 的 `AWF_PROBE_WEB_PORT` |
| pnpm | **本机没有** → `dsh plugin add` 不可用 | 有 pnpm 的机器可直接用官方路径；没 pnpm 就用 `.awf/probe/dsh/install-fixture.sh` 的离线等价装配（F13） |
| 浏览器桥（bbx） | 可用（用于 UI 真实页面验证） | 需要时由你在扩展里启用；不用也不影响 P1 |
| `claude` 命令 | PATH 上**没有** → init 相关 4 例测试预期失败 | 有 claude 的机器上应复跑确认 |

---

## 5. 探针环境重建（若 `.awf/probe/` 丢了）

```bash
mkdir -p .awf/probe/dsh/{patches,fixtures}
# 需要的脚本（内容见本文件 §6 的职责说明，或从上一台机器的打包件恢复）：
#   env.sh               强制 DSH_HOME=/tmp/awf-dsh-probe；防呆禁止指向真实 home
#   serve.sh             静默起停探针后台（--no-open）；start|stop|wait
#   guard.sh            真实 ~/.dsh 配置面指纹（snapshot|check）——证明零副作用
#   install-fixture.sh   离线装配插件到 profile（替代 pnpm）
#   patches/port-39081.yml  覆盖 webserver 端口（注意：include patch 是浅覆盖，config 要给全，F14）
#   fixtures/probe-plugin/  主探针插件（路由 ping/mount-mcp/task-round/oneshot/skills/compact-probe…）
```

**关键经验（重建时最容易踩的坑）**
1. 插件运行时装配必须放 **`ctx.inject([...services], cb)`**；放 `apply` 顶层或 `setTimeout` 之后都会命中非活动上下文（F25）。
2. `sessionController.prompt(request, signal)` 的 **signal 是第二位置参数**（F26）。
3. MCP 工具注册**异步**：挂载后立刻提问会看到「没有该工具」；派发前必须等注册（F29）。
4. 判定「工具是否可用」看 **`session.requestHeader().tools`**，不要用 `agent.ctx.tools.get`（F30）。
5. `workspace-write` 等 preset 的贡献在 **agent 平面的 isolate realm**，root ctx / `agent.ctx` 都可能取不到（F32/F35）。
6. include patch 的 `config` 是**浅覆盖**，覆盖 `webserver` 必须给全 `host`（F14）。

---

## 6. 现在该做什么（P1 入口）

**P0 状态**：T-P0-01～T-P0-14 全部收口，唯一 `in_progress` 是 **T-P0-12 的 U14 实机确认**（需要你在真实页面确认
「执行中输入禁用 / 暂停 AWF 按钮 / 响应结束后介入」三条；不影响 P1）。

**P1 任务（执行记录 §2.3，全部 pending）**

| 编号 | 内容 | 关键约束 |
|---|---|---|
| T-P1-01 | `ports.cjs` 按项目解析 adapter；`ccShapes`→`shapes` 去 CLI 化 | **不改**调度算法 |
| T-P1-02 | `ctx.tmux` → `ctx.host` 能力化；`ENTER_DELAY_MS` 下沉进 cc 实现 | 同批迁移消费者，不留双名 |
| T-P1-03 | `cli/lib/session.cjs` 5 处 tmux 直连 + `attach.cjs` 收口；`session` 端口转正 | 现在 CLI 硬绑 tmux |
| T-P1-04 | 编排模板迁入 server（模板与平台参数分离） | 技能/worker/决策资产保持单源 |
| T-P1-05 | 测试分层：编排层 CLI 无关 + conformance + **契约自检（可执行必填方法名断言）** | 测试走「改」不走「加别名」 |
| **T-P1-06** | **`run -r` 最小恢复修复**：把「查询活跃 run 并挂接」补进 `-r` 分支（与 `--attach` 同路径） | U3 已确认范围；**不**新增崩溃恢复、**不**自动重置 active |

**P1 硬门槛**：每次改动后 `npm test` 全绿（除已知的 `init.test.js` 环境性 4 例）+ `npm run check:arch` 通过。
P1 是**动 CC 生产代码**的阶段，务必小步提交、先保 CC 可用。

**P2 已明确的接线项（来自 P0 结论，避免重复试错）**
- 建会话：`sessionController.create` + `setup: installModelSelection + agentPresets.mount`（缺一即「裸 agent」，F19）。
- 挂 MCP：**会话作用域** `agentCtx.plugin(McpClient, {env:{AWF_PROJECT_ROOT}})`，派发前等注册（F29/E-03）。
- 派发：`sessionController.prompt(request, signal)`（F26）。
- 停止：`cancel()` 只是发起，**完成信号是 `whenIdle()`**；停整 run 要**逐个 `subagents.interrupt`** 子 Agent（E-06）。
- approval：按会话 `permissionPresets.set(session,'workspace-write')`（U16）。
- 上下文：**换新会话 + handoff 快照**（U17）；压缩需在 preset 同 realm 接线（F35）。
- 返回体：`awf_read_state` 默认全量 346KB、`summary:true` **静默无效** → 必须做真摘要 + 未知参数报错（E-10）。
- 资产：技能/命令属 **agent preset 平面**，不能假设全局根目录被发现（E-10 A）。

---

## 7. 纪律（别丢）

1. **不动用户真实 `~/.dsh`**：实验前 `guard.sh snapshot`，实验后 `guard.sh check` 必须 `IDENTICAL`。
2. **实验静默**：一律 `--no-open`，不弹浏览器。
3. **证据分类**：静态核查 / 替身测试 / 真实运行 三类分开说；「假件通过」≠「DSH 可用」。
4. **失败不降级**：worker 权限、子 Agent 身份等既定要求不满足时，记录冲突并回报，不自行改用弱实现。
5. **未知不装成功**：无法核实的结果不得显示为成功。
6. **保留历史**：文档追加不覆盖；用户原始回答不修改；未提交文档不丢弃。
7. **新取舍进清单**：追加到 `dsh-adapter-checklist-codex.md` 并标「未确认」，同时同步到执行记录。

---

## 8. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 建立本接续文件；P0 收尾；登记 U15/U16/U17 与 F01～F35；给出 P1 入口与 P2 接线清单 |
