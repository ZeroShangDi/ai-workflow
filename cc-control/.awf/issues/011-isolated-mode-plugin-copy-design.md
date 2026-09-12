---
id: "011"
title: "隔离模式（--port）靠「复制并改写插件副本」实现，与 Claude Code 的插件注册表冲突"
status: open
labels: [bug, tooling, regression, design]
assignee: null
milestone: null
priority: high
created: 2026-09-12
updated: 2026-09-12
deps: []
related: ["T3-011", "009", "010"]
---

# 隔离模式靠「复制并改写插件副本」实现，与插件注册表冲突

**一句话**：`npm run test:real -- --port N` 要的是「另起一个 server 跑当前工作树」，但因为**端口是
渲染期烘死在插件文件里的**，harness 只能复制一份 `plugin/` 改掉副本端口、再把沙箱项目的 marketplace
指过去。这份副本既达不成目的（会话未必加载它），又制造了一堆副作用（残留、双插件来源、hook 被劈开）。

## 一、隔离模式是什么（先把设计说清）

常驻 server（8787）跑的是它**启动那一刻**的代码。改了 `src/server/**` 却不重启它，回归测到的仍是旧
实现 —— 这条在 `tests/regression/fullflow-regression.mjs` 的 `§隔离端口` 注释里写得很清楚。
`--port N` 就是：另起一个 server 在端口 N 上，跑**当前工作树**，让这一轮回归测的是手里这份代码。

它解决的是「测试对象是哪份代码」的纯度问题，**不是**用例之间的隔离。

## 二、为什么当初需要副本

会话侧要打哪个 server，取决于插件目录里那些文件写的是哪个端口：

| 消费方 | 端口来源 | `--port N` 下能否跟随 |
|---|---|---|
| `awf-state` MCP | 运行时 `process.env.CC_PORT`（`server.cjs:81`） | ✅ 天然跟随 |
| **hook 网关** | **argv**：`node gateway.cjs 8787`（`hooks.json`，渲染期烘死） | ❌ |
| **`awf-session` MCP** | **env `AWF_BASE`**：`http://127.0.0.1:8787`（`.mcp.json`，渲染期烘死） | ❌ |

两个 ❌ 就是副本存在的全部理由：要让沙箱会话打 8799，就得有一份「写着 8799 的插件」。

## 三、它为什么不生效（缺口 #20 的两处实测）

- `--case single --port 8799`：hook 投到了 **8787**（网关留痕写「端口 8787」），隔离 server 的
  `server.log` 整轮 0 条 `[hook]` → 「60s 未收到 SessionStart → 继续派发」在隔离模式下**必然发生**；
- `--case dynamic-planning-run --port 8799`：沙箱会话**根本没加载 provider 插件** →
  `/ai-workflow-code:w-dev` 被判 `Unknown command` → prompt 被丢 → case 0/1（重跑同样失败）。

机制线索：`installed_plugins.json` 里这些插件的 project 条目 `installPath` 指向**不存在的 cache 目录**、
`known_marketplaces.json` 的 `ai-workflow-dev` lastUpdated 冻在**第一次**运行的时刻 ——
**harness 每次把 marketplace 重指到一个新临时副本，而 Claude Code 的插件安装/缓存注册表并不随之
干净重建**：有时拿到旧的（→ hook 打 8787），有时拿不到（→ 命令未知）。

## 四、副作用（这份副本已经造成过的伤害）

- **副本残留被别的会话加载**（issue 009）：`.plugin-8799` / `.plugin-8899` 留在
  `sandbox/regression/` 下不删，之后任何**在仓库里跑的会话**都可能把它当第二个插件来源 ——
  实测 skill 从副本解析、hook 被劈成两份，SessionStart/Stop 只走副本那条死端口，run 卡
  `still busy (ready timeout)` 而亡。（该条已由 `fix(regression): 隔离插件副本移出仓库并用完即删`
  缓解，但那是**给一个本不该存在的机制打补丁**。）
- 每次回归都在沙箱里多一份完整插件副本（87 文件级），重建 + 重指 marketplace 都是额外动作。

## 五、建议：把端口变成运行时覆盖，然后删掉副本机制

让 hook 与 `awf-session` 和 `awf-state` 一样**以运行时 env 为准**：

- `gateway.cjs`：`CC_PORT` 有值即用，无值回落到 argv；
- `awf-session`：`CC_PORT` 有值即组 `http://127.0.0.1:<CC_PORT>`，无值回落 `AWF_BASE`。

可行性：`scripts/bootstrap.sh:37` **已经**把 `CC_PORT` 注入会话环境，而它的取值就是同一个 config 单源
端口 —— 也就是说正常运行下 env 与渲染值**本来就一致**，改动不改行为；只有隔离模式会主动让两者不同。

改完后 harness 可以**整块删掉** `isolatedPluginDir` / `repointMarketplace` 与相关调用：沙箱项目挂仓库
原版插件，会话 env 里的 `CC_PORT` 指哪打哪。

收益：缺口 #20 消失、副本残留一族（含 issue 009 的观测现象）消失、marketplace 不再被反复重指、
回归不再与 Claude Code 的插件注册表较劲。

> T3-011 自己记的覆盖缺口 #20 里，候选修法 (b) 与此一致：「gateway 与插件命令的端口改为
> **env 覆盖优先**（harness 在会话 env 注入）」。

## 六、决议：删除（2026-09-12，用户 Q3 裁定）

**不再修隔离模式，也不采用 §五 的 env 覆盖方案 —— 直接删掉整个机制。** 用户给的判断：

> 隔离模式和副本模式都是为了在当前项目下 run 的过程中解决 server 变动的自测试问题，这第一不属于项目
> 本身需要的能力，第二平白无故增加了复杂度降低了稳定性……总之不要为了这个做太多的改动，这不是重点。

新口径（已落到代码与文档）：

- **删除**：`--port`、`isolatedPluginDir`、`repointMarketplace`、`stopIsolatedServer`、
  `ISOLATED_PLUGIN_DIR`，以及为它打的那些补丁（含 `fix(regression): 隔离插件副本移出仓库并用完即删`）。
- **真机回归在 run 之外由人跑**：跑前 `awf server stop`，让下一次 `awf run` 用当前工作树拉起 server。
- **run 内不做 server 侧代码的自测**。原因就是 Q1 的答案：宿主（run-host）活在 server 进程里，
  重启 server = 当场杀掉在飞的 run。故 `ownServer` 加了护栏：检测到在飞 run 就**显式失败**，
  而不是把 run 干掉（此前它会 `awf server stop` 直取常驻 server —— `--port` 一删就成了自杀开关）。
- **口径**：真机回归证明的是「编排链路在当前机器的真机上跑通」，**不宣称**「被测代码就是工作树最新那份」；
  后者由人在跑之前保证。

§五 的 env 覆盖方案作为**备选留档**（若将来确实需要自动化隔离，那是比副本更干净的路），当前不做。

