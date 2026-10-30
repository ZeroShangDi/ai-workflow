# DSH 插件的形态：一个自包含目录 = 安装单元

> 2026-09-19。回答一个问题：**cc 插件里的代理 / 命令 / 技能 / MCP / hook，在 DSH 该以什么形式存在？**
> 基线：`server/adapters/dsh/plugin/` 重做；此前那版把技能做成指向 cc 的符号链接森林、
> 把命令正文硬编码进 `index.js`、又靠 `awfRepo` 指到 cc 插件树取 MCP server —— 三条都违反
> 「一个文件夹装完」。

## 1. 一句话

`server/adapters/dsh/plugin/` 是一个**不引用目录以外任何东西**的 Cordis 包：
命令、技能、子 Agent 定义、MCP server、hook 订阅全部在包里，装配时由插件自己读。
安装 = 把这个目录整个拷进 `$DSH_HOME/profiles/<p>/node_modules/awf-dsh-plugin` + 在
`cordis.patch.yml` 里加一行。删掉一行 `awfRepo`，删掉往 `$DSH_HOME/skills` 铺链接的那一整套。

## 2. 概念映射（这是本文的核心）

| cc 形态 | DSH 形态 | 平台依据 |
|---|---|---|
| `commands/*.md`（平台自己读目录） | `ctx.commands.register({name, description, input:{hint}, handler})` | **DSH 没有命令目录发现** —— 全树只有 `dsh-skill-filesystem` 扫文件系统；命令只能程序化注册。所以 md 在这边是**数据**，由 `lib/commands.js` 翻成注册调用 |
| 命令名 `ai-workflow-code:w-plan` | 扁平 `w-plan` | 命令名正则 `^[a-z][a-z0-9_-]*$` 禁冒号 |
| `skills/<n>/SKILL.md`（平台自己扫） | `agentCtx.skills.register({name, description, content, resourceBase})` | 注册口有 rank（RUNTIME_RANK=250）；在 setup 窗口用 agentCtx 注册 = **该会话作用域层** |
| `agents/awf-worker.md` + `subagent_type` 引用 | **一个独立的 `tool-subagent` 实例**：`toolName: awf_worker` + `persona` + `toolFilter` | **DSH 没有 subagent_type 注册表**（`dsh-tool-workflow` 甚至显式拒绝 `agentType`）。命名身份靠「调哪个工具」表达 —— 这正是 `standard/agent.cordis.yml` 自己的用法（`subagent` / `subagent_fork` 各一行） |
| `agents/*.md` 的 `tools:` 白名单 | 实例的 `toolFilter.allow`（名字映射后） | 平台语义：滤掉的工具**从提示词里消失且拒绝执行**（单一可见性） |
| `.mcp.json` + 包内 server 脚本 | `agentCtx.plugin(McpClient, {transport:'stdio', serverName, command, args, env})` | 必须落在 **agent 发布前**的 setup 窗口；`sessionController.create` 没这个窗口（挂了也进不了工具表，实测 0 个工具） |
| `hooks/hooks.json` + `gateway.cjs`（平台 fork 进程） | 进程内 `ctx.on(...)` 订阅 | DSH 没有 hook 文件机制。等价事件见 §5 |
| `plugin.json` / marketplace | 无对应物 | Cordis 包 = 普通 ESM 模块导 `name`/`inject`/`apply`；装进 profile 靠 patch 行指名包。`package.json` 里**没有**能声明命令/技能/代理的字段 |

**一句话概括差异**：cc 是「放文件，平台自己发现」；DSH 是「写代码，运行时注册」。
所以这边多了一层 `lib/assets.js` —— 从包内读 md、解析 frontmatter，再喂给各注册口。
**代码只搬运，不改写**：注册给平台的每一条内容逐字节等于 md（`tests/unit/dsh-plugin-assets.test.js`
有正面断言；另有一条只抓逐字复制的弱断言，强度差异在测试注释里写明了）。

## 2.1 平台参数的归属：住在各平台自己的插件包里

原来是「cc 的 `prompts.json` 放 `platform-vars` 缺省表 + `platform-vars-dsh` 覆盖」。两个毛病：
DSH 的工具措辞住在 cc 的目录里（包不自包含），且**缺项会静默回落成 cc 口径**（发出
`Agent 工具` 这种 DSH 没有的东西）。

现在：cc 在 `cc/plugin/plugin-code/prompts.json`，DSH 在 `dsh/plugin/prompts.json`，**位置对称、
内容各写各的**。`server/shared/prompts.js` 按 adapter 读对应那一份，键集不一致直接报错（不回落）。

同一套位置也用在 plan 入口：`plan-entry-mode: 'command'`（cc，平台自己展开斜杠命令）vs
`'expand-command'`（DSH，平台只在网页输入框展开命令，API 注入不走 handler）。
expand 模式下入口正文**取自插件的 `commands/w-plan.md`** —— 以前 `prompts.js` 里内联过一份
「浓缩版」，那是命令 md 的缩水副本，命令改了它不会跟着变（两份真值），已删除。
入口的三段措辞（恢复 / 缺描述 / 输入框标题）在 DSH 插件的 `prompts.json` 的 `plan-entry` 段。

## 3. 目录对照

```
cc/plugin/<包>/                            dsh/plugin/
  */commands/*.md                  ────────►  commands/*.md          （多了 description/hint frontmatter）
  */skills/<n>/SKILL.md            ────────►  skills/<n>/SKILL.md    （真实文件）
  plugin-code/skills/...          ────────►  （同上，同构）
  core/agents/*.md                ────────►  agents/*.md            （3 个）
  core/mcp/*/server.cjs           ────────►  mcp/*/server.cjs       （随包携带 + mcp.json 声明）
  core/hooks/{hooks.json,gateway.cjs} ────►  hooks/{hooks.json,index.js,turn-reporter.js,approval.js}
  （无）                          ────────►  lib/*.js                （装配与平台操作，不属于「资产」）
```

CC 市场里的插件在 DSH 侧**合并成一个包** —— DSH 的安装单元是
「一个 profile 里的一行」，不是一个市场。技能名与命令名保持与 cc 一致（只有命令名去掉命名空间）。

## 4. 为什么「link 一个文件夹」在这儿只能落成「拷一个文件夹」

实测（Node 24，`node` 默认旗标）：

```
$ ln -s ../real nm/pkglink && node nm/pkglink/index.mjs
裸 import 解析失败 → ERR_MODULE_NOT_FOUND Cannot find package 'dep' imported from /private/tmp/symres/real/index.mjs
$ node --preserve-symlinks nm/pkglink/index.mjs
同样失败
```

Node 按**真实路径**解析包的裸 import。插件软链进 `<profile>/node_modules/` 后，
`import('@deepseek-ai/dsh-llm')` 会从仓库目录往上找，**永远到不了 profile 的 node_modules**。
（探针夹具之所以用软链还能跑，是因为 `install-fixture.sh` 另外把 `@deepseek-ai/*`
链进了仓库里插件的 `node_modules/` —— 那是开发期拐杖，发布形态不能依赖。）

所以：

- **安装单元 = 一个文件夹**（用户要的）✅
- **装法 = 整目录拷贝**（Node 的约束），排除 `node_modules`，依赖经 profile 解析 ✅

好处是插件运行期真的自包含；代价是改 md 后要重跑一次安装（旧的链接森林可以「改源即生效」）。
这一步在 §8 的第二步会被构造器接管，不再需要手工重来。

## 5. hook 映射

`hooks/hooks.json` 是**插件自己的订阅表**（cc 那份是平台清单，形状保留、语义变了），
`hooks/index.js` 读表接线。改接线不用翻代码。

| cc hook 点 | DSH 事件 | 覆盖情况 |
|---|---|---|
| SessionStart | `session/event` | ✅ 主会话 turn/start → `turn.started`（busy 语义另侧） |
| UserPromptSubmit | `session/event` | ✅ 同上（DSH 靠会话事件火线，不靠输入拦截） |
| Stop | `session/event` | ✅ turn/end → `session.ready` + 末条 assistant 文本（决策门阀读它 = cc 的 `last_assistant_message`） |
| SubagentStart | `session/event` | ✅ 子会话 turn/start → `agent.started` |
| SubagentStop | `session/event` | ✅ 子会话 turn/end → `agent.stopped` + RESULT/NEEDS_INPUT 正文 |
| PermissionRequest | `approval/request`（waterfall） | ✅ 只记录 + `next()` 委派，不自动批准（U16） |
| PreToolUse / PostToolUse / PreCompact | 未接 | ❌ 见下 |

**未接的三个**（`hooks.json` 的 `notWired` 里有同样的话，不藏在代码注释里）：

- `PreToolUse`：cc 拿它拦 `AskUserQuestion` 报决策请求。DSH 的等价事件是 waterfall 的
  `user-questions/request`（工具名 `ask_user_question`）。当前 AWF 决策门阀走「回合末
  `<AWF_DECISION_REQUIRED>` 标记 + Stop 事件」，**没接这个口** —— 接上能缩短决策检测延迟，
  但要动 AWF 侧的决策链路，不在本轮范围。
- `PostToolUse`：进度观测。AWF 靠 state 轮询判进度，未接。
- `PreCompact`：DSH 无对应事件；压缩经 `session/event` 的 `compaction/*` 观察得到，
  AWF 的上下文压缩走自己的 `features/context`，未接。

## 6. 装配时机：分两层，且**取服务必须经 inject**

| 时机 | 装什么 | 为什么 |
|---|---|---|
| `apply(ctx)`（进程级） | 命令、hook 订阅、指令通道 | 与单个会话无关，且命令要在网页输入框可用 |
| `setup(agentCtx)`（**会话级**，`agents.create` 的窗口） | 技能、命名子 Agent、MCP | 三者都需要 agent 作用域；且**只有 AWF 建的会话该看到它们** |

### 6.1 取服务不能在 `apply()` 顶层直接取（真机踩到，F25）

第一版在 `apply()` 里写 `ctx.get('commands')` 然后注册 —— 真机重启后日志是：

```
[awf-dsh][info] 已接线 2 条订阅：session/event, approval/request
[awf-dsh][warn] commands 服务不可用 —— 不注册任何 /w-* 命令     ← 全部命令没了
```

hook 接上了、命令一条没有 —— **静默少一半功能**。原因：本插件由 profile patch 层插入，
`apply()` 的时机早于 base bundle 的 `commands` 注册表上线，顶层取恒得 undefined。
探针坑位清单的 F25 早有这条（「运行期装配必须放 `ctx.inject([...services], cb)`」），
写的时候没照做。

平台自己的命令插件用的都是**声明式**注入（`dsh-command-goal: inject = ["commands","goals"]`、
`dsh-command-compact: inject = ["commands","compaction"]`）。本插件用**运行时**形式：

```js
ctx.inject(['commands'], (commandCtx) => registerCommands(commandCtx, { log }));
```

等价于声明式，但不会因为 `commands` 缺席就把整个插件（含指令通道与 hook）一起拖住。
`tests/unit/dsh-plugin-assets.test.js` 有一条回归断言钉死这个形态：apply 期间命令一条都不许注册，
只能交给 inject 回调。

技能为什么不挂全局：`$DSH_HOME/skills` 是全局技能根（rank 400），把全部 AWF 工作流技能
铺进去，会让用户**自己开的每个 DSH 会话**的提示词里出现无关技能，还会 first-wins
抢掉用户同名技能。会话级注册只影响 `awf plan` / `awf run` 自己建的会话。

顺带的后果（与 cc 一致，不是缺陷）：**worker 子会话看不到这些技能** —— 子会话由平台内部
create，没有它的 setup 窗口。cc 侧同样如此（`awf-worker` 的 `tools:` 白名单里没有 `Skill`）。

## 7. 白名单不猜：`toolFilter` 的核验手法

`tools.restrict()` 对**未知工具名必然抛错**（平台语义：「unknown names fail startup」）。
所以 `lib/agents.js` 在装配前逐个试挂再立刻摘掉（同一 tick 内完成，没有 agent 跑在那段瞬时
限制里），把工具面里不存在的名字剔除并留痕 —— 这是**问平台**，不是猜名字。
核验手段本身不可用时（不是 unknown-tool 的错），不据此剔除，原样放行并留警告。

映射表（cc → DSH）来自 `standard/agent.cordis.yml` 实际挂载的工具行：

| cc | DSH |
|---|---|
| Read / Write / Edit | `read` / `write` / `edit` |
| Glob / Grep | `glob` / `grep` |
| Bash | `bash` |
| WebFetch / WebSearch | `web_fetch` / `web_search` |
| TodoWrite | `todo_write` |
| AskUserQuestion | `ask_user_question` |
| Skill | `skill` |
| Agent | 本插件的 `awf_worker` 等命名实例 |

## 8. 第二步：一份源 + 两个构造器（已落地）

源与构造器都上线了。**内容只有一份真值**：包根的 `plugin/`。

```
plugin/                                   ← 中性源（唯一手写 md 的家），按插件包分目录
  core/{commands,skills,agents,mcp}/         清单类（plugin.json/.mcp.json/hooks）不在源里
  decision/skills/                           —— 那些由 render-config.mjs 从 config.json 渲染
  plugin-code/{commands,skills}/

server/adapters/cc/build.cjs   → server/adapters/cc/plugin/<包>/<内容目录>/   遍历各包，**纯拷贝**
server/adapters/dsh/build.cjs  → server/adapters/dsh/plugin/<内容目录>/       各包**拍平**，带变换
```

产物目录像 `dist`：**gitignore，由 `npm run build:plugin` 生成**（`pretest` / `prebuild` / `prepack` 都会先跑，
所以 `npm test`、`npm run build`、`npm pack` 都拿得到完整产物；fresh clone 也不会读到空目录）。

### 元数据的口径：**超集，可以多，不要少**

源命令的 frontmatter 给每个平台留**自己的键**，不互相派生：

| 键 | 谁读 | 说明 |
|---|---|---|
| `description` | 两边 | — |
| `argument-hint` | cc | CC 的输入提示键（canonical） |
| `hint` | dsh | `commands.register` 的 `input.hint` |
| `empty-input` | dsh | 无输入时的引导语 |

cc 侧**一个字段都不删**（`cc/build.cjs` 就是纯拷贝）。依据是实测而非推测：
`claude plugin validate --strict` 对三个包**零警告** —— CC 运行时容忍未识别键；
反倒是**命令没有 frontmatter 本身**会招一条警告（`No frontmatter block found … to set description`），
补上它才消掉。（技能与代理的 frontmatter 更必须原样留：那是定义，不是元数据 —— 写第一版时
无差别剥离把 cc 的代理定义剥没了。）

### 变换（都在 `dsh/build.cjs` 的 `BODY_RULES` 里，逐条有真机依据）

| 差异 | cc 侧（源） | dsh 侧 |
|---|---|---|
| 命令名 | 加命名空间 `ai-workflow-code:w-plan` | 扁平 `w-plan`（正则禁冒号） |
| 命令 frontmatter | `argument-hint` | `hint` + `empty-input`（DSH 强校验） |
| 正文里的命令引用 | `/ai-workflow-code:w-dev` | `/w-dev` |
| 代理引用 | `subagent_type: ai-workflow-core:awf-worker` | 工具名 `awf_worker` |
| 交互工具 | `AskUserQuestion` / `Skill 工具` | `ask_user_question` / `skill 工具` |
| 派生工具措辞 | `Agent 工具` | `subagent 工具`（代理身份里写实成 `awf_worker 工具`） |
| 插件切分 | 多个市场插件 | 一个包（DSH 安装单元是一条 patch 行） |
| 代理 max-depth | 无 | frontmatter 加 `max-depth: 0`（DSH 侧平台配置） |
| MCP server | 原样 | 改写包外 require（`store-core`/`task-graph` → `mcp/_lib/`），去掉 cc 专有的 `awf-oneshot` |

**这些规则是临时的**：用户已定，正文里这些引用**后续会变成变量、由各侧维护**。
届时 `BODY_RULES` 整段被替换成占位符填充。

### 代码不进构造器

cc 的 `hooks/gateway.cjs`、`settings.json`、`.mcp.json`、`plugin.json`、`plugin-code/prompts.json`，
dsh 的 `index.js`、`lib/**`、`hooks/*`、`prompts.json` —— 都还是**手写**。构造器管的是
「命令 / 技能 / 代理 / MCP server」四类内容。

### 验收（`tests/unit/build-parity.test.js`）

判据是**逐字节**的，不是「跑通就行」：

- cc 侧四类内容目录与源**逐字节相同**（证明没被动过）；
- dsh 侧的变换**恰好**是声明的那些 —— 产物里没有 `/ai-workflow-code:`、`subagent_type`、`AskUserQuestion`，
  且断言这些**确实在源里**（否则是空断言）；
- 构造可复现（连跑两次逐字节相同）；
- 测试在**临时根**里构造，不碰真实产物目录（并发时读的一侧会看到半写状态 —— 踩过）。

迁移期的一次性硬证据：构造器首次落地时，产物与「源还没统一之前」那两棵树逐字节比对 ——
cc 7/7、dsh 4/4 全等。那条比对不可重复（快照不进库），留下的是上面这些可重复的不变量。

## 9. 本轮明确没做的事（不装作做了）

1. **语义层的平台化**：命令/技能正文里还有大量 cc 语境 —— `claude -p`（DSH 的一次性调用
   走 `llm.stream`）、`w-monitor` 整个建立在「监控 tmux 里的 Claude Code」之上（DSH 侧没有
   tmux 会话）。本轮只改了**机制措辞**（命令命名空间、`subagent_type`、`Agent 工具`、
   `AskUserQuestion`），业务实质一字未动。要动的话需要对每条命令单独判断「在 DSH 上还成立吗」。
2. **plan 入口的体量变了**（行为变更，需真机复核）：以前注入的是 C29 之后的「轻量版」，
   现在注入 `w-plan.md` 全文（~9.4KB）。两件事要说清：
   - 这其实是**回到**真机验过的形态：F46 记录的就是「展开命令正文 + 需求原文」，
     当时真机收到的首条消息是 4952 字的 w-plan 指令；C29 之后才换成轻量版。
   - 轻量版是命令 md 的**缩水副本**（两份真值），按「不在代码里写属于 md 的文本」这条规则
     必须删。若实测发现 9.4KB 对 DSH 的上下文/落账有影响，正确的修法是**改 `w-plan.md` 本身**
     （让两端一起变），而不是在代码里再放一份短的。
3. **worker 的 `awf_read_state` 权限**：`awf-worker.md` 的白名单里有
   `mcp__awf-state__awf_read_state`，但 MCP 是挂在**父会话自己的作用域层**，子会话是否继承
   未实测。§7 的核验是保守的（从父会话视角看，自己那层不算「可限制」），所以这个名字会被
   剔除 —— worker 拿不到 state 直读（任务正文里已经带着上下文，所以不影响主链路）。
   **要真机核实**：若子会话确实继承父会话的 MCP 层，把 `lib/agents.js` 里对 `mcp__*` 的
   核验改成「我们挂的 server 直接放行」即可，一行的事。
4. **`awf-session` 默认不挂**：`mcp.json` 里声明了但 `mountByDefault: false`，维持现状
   （审计 A09 指出上下文交接需要它 —— 那是行为变更，不在本轮结构改造范围内）。
5. **命名子 Agent 的装配手法未真机核验**：现在用 `agentCtx.plugin(ToolSubagent, config)`
   （走 `dsh-tool-subagent` 的 standing 分支，与 `standard/agent.cordis.yml` 里那几行同一路径；
   要求 `scopeOf(agentCtx)` 有值）。另一条路是直接 `ToolSubagent.apply(agentCtx, config, agent.session)`
   走「direct Agent setup」分支（`setup` 的第二个参数就是 agent，能拿到 session）。
   挂不上时 `lib/agents.js` 会 `log('error', …)` 并把 `details[].error` 留在返回值里，
   真机一跑就能看出来 —— 但**这一条必须真机验**，别拿单测当数。
6. **本轮的验证只到单测**：1239 项单测 + 结构门禁通过；**没有跑真机**。§7 的白名单核验、
   §6 的会话级技能是否真进模型目录、命令是否真出现在网页输入框 —— 三条都要靠
   `scripts/probe/dsh/roundtrip.cjs` 复核（探针的 `session.create` 回执里现在带
   `skills` / `subagents` 两个字段，可以直接断言）。
