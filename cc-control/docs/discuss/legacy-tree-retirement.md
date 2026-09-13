# 旧树 `src/` 退役收口方案（讨论稿）

> 2026-09-13 · 状态：**已评审通过，执行中**
> 触发：新树 `server/` + `cli/` 已在真机跑通（e2e `multi-agent-parallel` 11/11、regression 76/76、单测 1060）；
> 用户裁定「新树可以跑通了，现在进行收口」——删旧树 `src/` 并解开全部指向它的依赖。

---

## 一、背景：为什么必须一次做完

两套实现并存：**新树** `server/` + `cli/`（真机 e2e / regression / 单测都跑在它上面）与**旧树** `src/`
（76 个 `.js/.cjs` + 模板 + 构建产物）。表面上「删一个目录」而已，实际删 `src/` 会同时打断五条链路：

| 断点 | 证据 |
|---|---|
| **构建** | `scripts/render-config.mjs:24` 硬 `import` 旧树；`scripts/build.sh:10-11` 语法检查旧树入口；`set -e` 下直接失败 |
| **发布包** | `package.json:7` `bin.awf` → `./src/awf.js`；`:11` `files` 只含 `plugin/`+`src/`+`scripts/` —— **新树根本没进包** |
| **插件 MCP** | `plugin/core/mcp/awf-state/server.cjs:23,28`、`awf-oneshot/server.cjs:16` 回取旧树，`try/catch` **静默降级** |
| **测试** | 70 个测试文件 import 旧树（详见 §三） |
| **结构门禁** | `scripts/check-architecture.mjs` 的规则、白名单、扫描根全部硬编码 `src/` |

分次做只会反复红，所以按「先接线 → 再重定向测试 → 再改门禁 → 最后删」的顺序一次走完。

## 二、判据（沿用本仓既有约定，不新造）

取自 `.awf/RULES.md` 与 `docs/discuss/ai-refactor-retro-v0.2.0.md`：

1. **删除判据**：生产侧零引用 **且** 能力已在 live 路径别处实现（测试 import 不算采用 —— 复盘 K1/K2）。
2. **未收口必须结构化登记**：不能悄悄丢能力。丢 → 要有 issue；留 → 要有实现（复盘「沉默的 `false` 等于没有登记」）。
3. **验证器自身要能被验证**：每个验证手段都要有元验证（复盘 K8）。
   本方案里对应「门禁扫 0 个文件 → 永远绿」这条沉默失效。
4. **只写能取证的**：文档给 `文件:行号`，自述与实现不符按缺陷处理（复盘 K4）。

## 三、范围

### 3.1 旧树残留分类（调查结论）

| 类别 | 数量 | 处置 |
|---|---|---|
| **A 有新树对应物** | ~70 | 随 `src/` 删除 |
| **B 旧树独有** | 见下 | 迁 / 裁决 / 登记 |
| **C 纯死代码** | `src/templates/w-tree-template.html`、`src/templates/CLAUDE.md.template`(0 字节) | 随 `src/` 删除 |

**B 类逐条**：

| 文件 | 说明 | 处置 |
|---|---|---|
| `src/lib/plugin-config.js` | 插件注册文件渲染器（`readPluginConfig` / `renderMcpServers` / `renderPluginJson` / `renderMarketplace` / `renderRepoSettings` / `resolvePluginAssets` / `enginePluginRoot`）。**唯一会打断构建的**；新树 `server/shared/plugin-assets.cjs` 只有定位原语，无任何 `render*` | **迁移**（P0-2） |
| `src/lib/ui/*`（colors / log / spinner / task-list / run-follow） | 旧 CLI 终端表现层；新 CLI 走朴素 `console.log`（`cli/commands/run.cjs` 内有 `renderEvent`/`taskLine` 雏形） | **登记不迁**（P5，边界见 §六） |
| `src/lib/version.js` | 交互式版本选择器；两处调用点早被注释停用 | **废弃**（测试同删） |

### 3.2 测试绑定面（77 命中，其中 7 个是误报）

误报的 7 个 import 的是 `web/src/`，与旧树无关。真实绑定 **70 个**：

| 类 | 数量 | 含义 |
|---|---|---|
| **R**（改路径） | 57 | 新树有同名/同职责模块，多数两侧导出名逐字相同 |
| **M**（改写） | 9 | 架构变了需重写断言，或能力尚未迁需先迁 |
| **D**（删） | 4 | 测的是已废弃的旧 CLI 行为 |

R 类中三处需二次映射：`state.test.js` / `gate-fix.test.js`（`MAX_RECHECK`、`spawnGateFixTask`、`gateFixMeta`
已移到 `server/features/gate/closure.js`）；`project-registry.test.js`（拆成 `server/runtime/project.cjs`
+ `server/runtime/registry.cjs`）；`plan.test.js`（改 mock `server/adapters/ports.cjs`）。

D 类：`version-prompt`（能力停用）、`run-follow` / `task-list`（旧 TTY UI）、`run-resume`
（`drainDecisionResume` 已删，续跑职责迁 server）。

### 3.3 本轮**不做**

- **`web/**`** —— 另一个模型正在重构（见 `web/ARCHITECTURE.md` 声明「仅修改 web/」），一律不碰。
  连带 `web/vite.config.js` 的 outDir 改指 `server/web/public` 一事留给对方提交。
- **那条既有红测试与任务图** —— `tests/unit/check-architecture.test.js` 的可达性断言读本仓库
  `.awf/state.json`，`T4-001` blocked → `T1-113` 不可达。与删旧树无关，**单独开一条**。
  *注：本轮改写门禁会把旧树那几条 `EXEMPTIONS` 一起删掉，该断言可能因此转绿 —— 属副作用，不作为本轮验收目标。*

## 四、执行阶段

### P0 前置接线（此阶段不删任何文件）

| # | 改动 | 位置 |
|---|---|---|
| 0 | **方案文档**（本文件） | `docs/discuss/legacy-tree-retirement.md` |
| 1 | `bin.awf` → `./cli/awf.cjs`；`files` 去 `"src/"`、补 `"server/"` `"cli/"` | `package.json:7,11` |
| 2 | 迁插件注册渲染能力 | 消费方 `scripts/render-config.mjs:24` |
| 3 | 语法检查路径改新树 + 过时注释 | `scripts/build.sh:10-11,23` |
| 4 | 插件 MCP 三处回取旧树改指新树 | `plugin/core/mcp/awf-state/server.cjs:23,28`、`awf-oneshot/server.cjs:16` |
| 5 | `serverScriptPath` 改指 `server/server.cjs`，让 `cli/lib/context.cjs:22` 的覆盖回归单源 | `server/shared/run-context.cjs:114` |
| 6 | **迁回会话就绪守卫**（见 §五） | `cli/lib/` + `cli/commands/run.cjs` |
| 7 | **迁回 server.log helper（含轮转）**（见 §五） | `cli/lib/` |
| 8 | coverage `include`/`exclude` 改 `cli/**` + `server/**` | `vitest.config.js:12-13` |

**第 2 条落点**：`plugin/config.json` 的形状已由 `server/shared/plugin-assets.cjs` 单源知情（定位原语）。
渲染是同一形状的另一知情者，宜并入该文件；落地时先核对 `server/adapters/cc/profile.cjs`
（新树已迁入的 `installProjectMcp` / `projectMcpJson`）以免重复实现，文件过大再拆 `plugin-render.cjs`。

### P1 测试重定向

按 §3.2 的 57 R / 9 M / 4 D 清单逐项处理。

### P2 结构门禁改根

`scripts/check-architecture.mjs` 逐项改：`LAYER_RULES`（层名按新树重定）、`ALLOWED`（新树真实边是
`cli → server`，现表里没有）、`ENTRY_ALLOWLIST`、`EXEMPTIONS`、`STRUCTURE_RULES`、
`SRC_CODE` / `collect(...'src')` / `PROD_DIRS` / `SKIP_PATHS`。
与 `tests/unit/check-architecture.test.js` 是「数据 ↔ 用例」绑死关系，任何表改动都要同步期望值。

### P3 删除

`rm -rf src/`（含 `src/server/public/` 构建产物与 `src/templates/` 整目录）。
`server/templates/` 是权威那份：`awf-config.json` 已漂移（新树多 `run.decision.mode`），旧那份不迁移。

### P4 文档与配置清理

`.gitignore` 旧产物规则与过时注释；`CLAUDE.md`（目录树 / 核心编排流程 / 架构原则 / **关键文件表**）；
`README.md` 目录表（整表是重构前形态）；`docs/features/*` 的源码路径、`docs/CHANGELOG.md`、
`plugin/README.md`、`plugin/plugin-code/skills/code-doc/SKILL.md`；
`server/shared/run-context.cjs:28` 注释里的 `server/core/…` 漂移。

### P5 登记：终端表现层取舍

`src/lib/ui/*` 本轮不迁，落 `.awf/issues/` 登记，边界由用户裁定（§六）。

### 提交切分

遵 `.awf/RULES.md`（文档/测试独立于功能实现，且排在功能之后）：
`P0-0`（本文件，独立一条）→ `P0`（功能）→ `P1+P2`（测试与门禁）→ `P3+P4+P5`（删除、文档、issue）。每段独立可跑。

## 五、两处**已发生的静默能力丢失**（本次调查发现，随 P0 一起还）

两条都是「能力已丢但没人知道」——正是复盘 K5「沉默的失败」的形态。

### 5.1 会话就绪守卫（`sessionSeq` 无消费者）

- 新 server **仍在产出**该信号：`server/runtime/session.cjs:147` `bumpSessionSeq()`、`:138` getter、
  `/status` 也照样吐（`server/web/api/session.cjs:49`）。
- 但 `cli/` 里 **`sessionSeq` 零消费者**（`grep -rn sessionSeq cli/` 无命中）。
- 旧 CLI 的 `waitSessionStarted`（`src/cli/run.js:176`）做两件事：等 `sessionSeq` 增长，**并每 5s 补一记 Enter**。
- 现状 `scripts/bootstrap.sh:47-49` 只有一记固定的 `sleep 3 + Enter`。旧代码注释记着这一记打空的真机现场
  （2026-09-10 dual-b：claude 起慢 → 文件夹信任弹窗仍在 → 随后派发的任务文本被打进弹窗丢弃 →
  **留下一个从没收到过输入的会话**，pane 空、无 transcript）。
- 结论：**迁回**。否则真机首次/并发启动时会复现同类失效（症状与
  `.awf/bugs/dispatch-without-subagent-hangs-run.md` 同属「提示词投递了但会话没动」这一类）。

### 5.2 server.log 轮转

- 旧树有 `openServerLog` / `serverLogPath` + 单代轮转（`maxBytes`）。
- 新树只在 `cli/lib/session.cjs:55-57` 内联 `fs.openSync(logPath, 'a')`，**轮转能力丢失 → server.log 无限增长**。
- 结论：**迁回 helper**（落点 `cli/lib/`，现唯一写点邻近）。

## 六、用户裁定项

| # | 裁定 |
|---|---|
| 1 | **`web/**` 一律不碰** —— 另一个模型在重构，避免撞车。 |
| 2 | **既有红测试与任务图不纳入本轮**，单独开一条。 |
| 3 | **结构门禁本轮改写指向新树**（不退役、不留空转）—— 保住「单测 → 结构门禁 → 真机」三层验证。 |
| 4 | **终端表现层 `src/lib/ui/*` 不迁移，建 issue 登记**；边界为：**内容由 server 提供，CLI 侧只负责输出与 UI**。 |

## 七、验证

| 手段 | 期望 |
|---|---|
| `npm test` | 无新增失败（总数会因 D 类删测试下降） |
| `npm run lint` | 通过 |
| `npm run build` | 通过（render-config → 语法 → **结构门禁** → web 构建 → `npm pack --dry-run`） |
| `node scripts/check-architecture.mjs` | **扫描文件数必须 > 0**（防「扫 0 文件 → 永远绿」） |
| 门禁元验证（负面用例） | 临时在 `server/` 里 import `cli/` → 必须报红 EXIT 1；复原后转绿 |
| `npm pack --dry-run` | 含 `cli/` + `server/`；`bin` 指 `cli/awf.cjs`；不再出现 `src/` |
| 全新目录装包冒烟 | `npm pack` → 装 → `awf --help` 可执行（验证 bin 切换真的成立） |
| `npm run test:real -- --fast` | 76/76 断言通过 |
| e2e 抽样 | `hello-sum`（单 agent）+ `multi-agent-parallel`（多 agent）各一次 |
| 会话就绪守卫 | 单测覆盖「`sessionSeq` 未增长时持续补 Enter、增长后放行」；真机可调小 `CC_SESSION_READY_TIMEOUT_MS` 观察 |

## 八、风险

| 风险 | 处置 |
|---|---|
| **门禁空转**（扫 0 文件永远绿） | §七 的「扫描文件数 > 0」断言 + 负面用例 |
| 与另一模型撞车 `web/` | 本轮完全不碰 `web/` |
| 插件 MCP 的 `try/catch` 把问题藏起来 | 改指新树后断言三处回取**真解析成功**，不只「catch 没报错」 |
| 迁 `plugin-config.js` 与 `profile.cjs` 重复实现 | P0-2 先核对已迁部分，再决定并入还是新增 |
