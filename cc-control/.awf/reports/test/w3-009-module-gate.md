# W3-009 模块测试门禁（质量与验证）— 非真结构核查报告

> 门禁任务 T3-009 · 2026-09-10 · 非真模块核查（对照模块 acceptance + 改动 diff 做结构/验收自检，
> 不跑整套真实测试、不强求新增真实用例；真实运行验证由 T1-098 真 run 承担）。
> 模块改动基线：`0a13101`（套件 hermitic 化）+ `d3286b3`（补齐单测/集成 + 回归 harness 归位）+ T1-099 未提交改动。
> 佐证：最新全量 **103 文件 / 861 例绿**；e2e 子集 **2 文件 / 8 例绿**；真机回归 **40/40**（本会话 2026-09-10T14:25Z 产物）。
> 门禁内 dev 任务 T1-095…T1-099 全部 done。

## 一、模块范围（W3-009 WBS desc 对照）

> 全量测试适配新结构并补齐组件级单测；自托管真 run 冒烟走完整新链路（cc 回归）；
> 架构纪律（依赖方向/隔离/事件 schema）文字化写入审查 checklist，重构各模块过 code-review-architecture。

## 二、验收点逐条对表

| # | 验收点 | 落地结构（文件:行为） | 判定 |
|---|--------|----------------------|------|
| 1 | 全量测试适配新结构 | `tests/unit/run-batch.test.js`(−178) 删除 → `tests/unit/batch-transport.test.js`(+144) 承接（cli/run-batch.js 已迁 `src/server/batch-transport.cjs`）；新增 `tests/unit/page-scope.test.js`(+126)、`session-ready-wait`、`task-channel-settle`；`tests/setup-env-scrub.js` + `vitest.config.js` setupFiles 使套件能在 run 会话内 hermitic 运行（清外层 `CC_*`/`AWF_*`）；`tests/e2e/*` 两处既有基线失败已修（见 §四） | ✅ |
| 2 | 补齐组件级单测 | 后端：adapter（`cc-adapters-smoke`/`hook-adapter`/`oneshot-adapter`/`interactive-adapter`/mock）、store（`store`/`store-core`）、迁移（`migrate`/`layout-migrate`）、config（`config-loader`/`run-config`/`runtime-config`/`render-config`/`plugin-config`）、装配（`run-context`/`run-context-project-sid`/`run-registry`/`project-registry`）、`run-id`/`run-stamp-sid`/`state-schema`/`sid-naming` 均在册 | ✅ |
| 2b | 前端 api/ws 层单测 | `tests/unit/web-api-client.test.js` + 5 组模型层（`web-dashboard-model`/`decisions-model`/`diagnostics-model`/`run-shell-model`/`wbs-tree-model`），覆盖 `web/src/api/client.js` 与 5 个 `views/*-model.js` | ✅（组件 `.jsx` 不在范围，见 L1） |
| 3 | 自托管真 run 冒烟走完整新链路 | `tests/regression/fullflow-regression.mjs` + `npm run test:real`；本会话实跑 `--case all`：single 6/6 · gate 6/6 · multi 4/4 · decision 9/9 · dual 15/15 = **40/40，exit 0** | ✅ |
| 4 | 架构纪律文字化写入审查 checklist | `code-review-architecture/SKILL.md` 新增「架构纪律（逐条取证）」三条（依赖单向/隔离/事件 schema 版本）；`w-review.md` 维度与输出补名与取证要求；`code-architecture/SKILL.md` 完成检查镜像同一批三条 | ✅ |
| 5 | 重构各模块过 code-review-architecture | 已实际应用：`scripts/check-architecture.mjs`（`npm run check:arch`）出层间导入证据；`.awf/reports/architecture-discipline-audit.md` 给出 W3-001…008 模块 × 纪律矩阵与 F1–F8 | ⚠ **审查已执行，结论含 6 条依赖方向越界 + 1 条 schema 版本缺口未收敛（见 §六）** |

## 三、结构自检（diff 维度）

- **测试与实现同步迁移**：删的测试对应已删的实现（`run-batch.test.js`→`batch-transport.test.js`），不是删掉了事；`run.test.js`/`cli-aux.test.js`/`cc-shapes.test.js`/`decision-gate.test.js` 按新结构改指向。
- **套件可移植性**：`setup-env-scrub.js` 是 T1-098 真 run 暴露的问题（嵌套 run 时 env 污染）反向修到单测层，属「真机回归倒逼确定性测试变好」的正循环。
- **真机 harness 本会话进一步定型**：补前置依赖检查（tmux/claude 缺失时中止于消耗 token 前）、单 case 失败隔离与证据必落盘、注册表自描述 + `--list`、证据约定（`evidence-<case>.json` 每 case 即写 + `evidence-all.json` 汇总）。
- **取证工具化**：`check:arch` 把「依赖单向」从散文变成可复现输出；它自身也在本次门禁前修正过一次漏扫（计算路径 `require`），见 §五 N-1。

## 四、佐证（既有绿测，不重复整套真跑）

| 项 | 结果 |
|---|---|
| 全量 `npm test` | 103 文件 / **861 例全绿** |
| `npx vitest run tests/e2e` | 2 文件 / **8 例全绿** |
| 真机 `npm run test:real -- --case all` | **40/40 断言通过，exit 0** |
| `npm run lint` / `npm run build` | 通过 |

**重构恢复审计的两项遗留 e2e 失败已清零**：`docs/bugs/recovery-baseline-e2e-failures.md` 记「T1-098 前必须清零」的
`e2e-smoke.test.js`（日志路径按旧 `.awf/logs/*.log` 断言）与 `run.e2e.test.js`（多 agent 分流 20s 超时）本轮均通过。

## 五、本门禁新发现（对照 diff 时查出，不属既有结论）

### N-1 · `coverage/` 陈旧产物入库（34 个跟踪文件）

- 证据：`git ls-files coverage` = 34 个文件，全部来自单个提交 `3c4a894 feat: 暂存测试代码`；`.gitignore` **无** `coverage` 排除项（`git check-ignore` 返回未忽略）。
- 内容：`coverage-final.json` 记录的是**重构前**的代码树，其路径现已全部不存在——
  `src/cli/paths.js`、`src/mcp/awf-state/server.cjs`、`src/server/tmux-keys.cjs`、`src/cli/logger.js`、`src/cli/state.js`，且根路径是另一台机器的 `/Users/v-shangjunhao/MyProject/...`。
- 影响：仓库里躺着一份描述「已不存在代码」的覆盖率报告；任何按它判断覆盖情况的人都会读到错的数据。
- 归属：W3-009「全量测试适配新结构」——产物未随结构迁移。**修复方向**：删除 `coverage/` 出库 + `.gitignore` 补 `coverage/`。

### N-2 · 6 个重构产出的抽象模块无生产接线，测试绿给出「重构已落地」的假象

按「生产侧（`src`/`scripts`/`plugin`/`web`）零引用、仅测试文件引用」逐文件核验，命中 6 个：

| 模块 | 生产引用 | 仅测试引用 | 对应交付 |
|---|---|---|---|
| `src/lib/run-registry.cjs` | **无** | `run-registry.test.js`、`sid-naming.test.js` | W3-006 「多 run 槽注册表」 |
| `src/server/app.cjs`（109 行） | **无** | `server-app.test.js` | W3-003 「server.cjs 拆为 bootstrap/api/…」 |
| `src/server/api.cjs`（119 行） | **无** | `server-api.test.js` | W3-003 「路由表 + 分发器」 |
| `src/lib/layout-migrate.cjs` | **无** | `layout-migrate.test.js` | W3-002 旧布局兼容读 |
| `src/server/session-launch.cjs` | **无** | `session-launch.test.js`、`sid-naming.test.js` | W3-004 会话启动收口 |
| `src/lib/persist-pipeline.cjs` | **无** | **无**（连测试都没有） | W3-002 落盘管道接口 |

核验方法：`grep -rn "<模块名>" src scripts plugin web`（排除自身）→ 零命中；非计算路径 require（`grep -rn "require(path.join" src` 无命中），故不存在动态加载的可能。

- **live 实现另在别处**：多 run 分片真正跑的是 `src/server/project-context.cjs`（209 行，`runSlots: Map` + `createProjectRegistry`），而 `run-registry.cjs` 是**平行机制**；`server.cjs` 至今 **1435 行**，`app.cjs`/`api.cjs` 是未接线的骨架；会话启动真身是 `src/cli/run.js:240 execSync('bash bootstrap.sh')`（shell 内拼 tmux + claude），`session-launch.cjs` 是**未接线**的 JS 版。
- **有据可查的「待接入」变成了永不接入**：T1-024 的 task result 自述 persist-pipeline 是「落盘管道接口建成……供 W3-003/004 接入」「metrics 真实管道与 events 总线由 W3-003/004 后续接入」；W3-003/004 均已 done，接入从未发生，且它连测试都没有。`session-launch.cjs` 头部同样写「live 切换……在 W1-044/069 等 host 接入任务执行」，T1-044/T1-069 均已 done。
- **影响（本门禁最重的一条）**：这批模块的测试是绿的，于是「重构已完成」在验证面成立了；但被验证的抽象层没有被任何生产路径采用。这正是 `code-architecture` 反复警示的**平行机制**，也是 W3-009「全量测试适配新结构」要防的事——覆盖了不等于接上了。
- 同时它修正了 T1-099 对 F1/F2/F5 的定性：`run-registry`（F1/F2）与 `session-launch`（F5 的一部分）都在死代码里，属**潜在**反向依赖，不是活违规；活违规只剩 `src/server/tmux.cjs`、`src/server/host.cjs` 与 `scripts/bootstrap.sh`。
- **修复方向**（属设计决策，不由门禁单方定）：每个模块二选一——接线到 live 路径，或删除/显式标注为未采纳草案。无论哪条，都必须让测试停止守护无人使用的实现。

### N-3 · `npm run test:coverage` 在本环境不可用（轻度）

- 证据：`@vitest/coverage-v8` 已在 `package.json` devDependencies 声明，但 `node_modules/@vitest/` 下无该包 → 运行报 `MISSING DEPENDENCY`。
- 影响：覆盖率入口实际上长期没人跑（这正是 N-1 的陈旧产物无人察觉的原因之一）。属环境/依赖未装，非代码缺陷，不阻塞。

## 六、遗留（承接自 T1-099，本门禁复核未收敛）

| 项 | 内容 | 处置 |
|---|---|---|
| F1/F2 | `lib/run-registry.cjs` → `server/statemachine.cjs`、`lib/run-diagnosis.cjs` → `adapters/oneshot.cjs` 反向依赖 | 注入点已在位，可小步收敛 |
| F3/F5 | `adapters/ports.cjs` → `server/host.cjs`/`hook-adapter.cjs`；host/hook 的实现（含 tmux/claude 字面）仍在 `src/server/`。**live 部分**为 `src/server/tmux.cjs`、`src/server/host.cjs`、`scripts/bootstrap.sh`；`session-launch.cjs` 虽含 `claude` 字面但属死代码（见 N-2） | 结构性，建议独立任务 |
| F4 | `src/cli/run.js` 直取 `src/server/run-settings.cjs` | 归 cc 端口或经 client |
| F8 | `src/lib/events.cjs` 事件信封 `{type,at,runId,payload}` 无版本字段 | 兼容读策略宜由 T1-101 架构终稿定 |
| F6/F7 | 插件 MCP 注释自述与实现不符；`PORT_CONTRACT` 的 `impl` 标记失真 | 低风险，随下次触及该文件一并做 |
| L1 | 前端 `.jsx` 组件不入仓 vitest（既有约定，记录在 `.awf/context/handoff.md`） | 不阻塞，真实 dev 验证时补 |

## 七、结论

模块五项验收点中 1–4 的表面证据**全部成立**（全量测试已随新结构迁移、后端组件级单测成面、前端 api/ws 与模型层在册、
真机回归 40/40、架构纪律三处入 checklist）；第 5 项「重构各模块过 code-review-architecture」**已实际执行**。

但本门禁对照 diff 时查出，这个「成立」有相当一部分是**验证面的假象**：

- 变化轴：本模块的价值在「重构是否真的可被验证」。而用过一次这套验证就发现——**测试覆盖的一批重构抽象从未被生产路径采用**（N-2：6 个模块零生产引用，其中 4 个还被测试守护着）。
- 被破坏的边界：`adapters` 未收口（活违规在 `src/server/tmux.cjs`、`src/server/host.cjs`、`scripts/bootstrap.sh`）；`server.cjs` 仍是 1435 行单体，`app.cjs`/`api.cjs` 骨架挂空；`run-registry.cjs` 与 live 的 `project-context.cjs` 构成平行机制。
- 附带物：`coverage/` 34 个陈旧跟踪文件描述着已不存在的代码树（N-1）。
- 期望归属：会话启动的权威实现落在 cc 适配器（`adapters` 端口），`server` 只经端口消费；重构产出的抽象要么接线、要么删除，不留悬空骨架；测试产物不得入库。

**本模块不修**（门禁只判不改）。故本轮不判 pass。

→ **verdict: changes_requested**

修复要求（按可执行度从高到低，供派生修复任务取材）：
1. **N-1**：`coverage/` 出库 + `.gitignore` 补 `coverage/`。
2. **N-2**：逐个处置 6 个未接线模块——接线或删除/显式标注；两者都必须让测试不再守护无人使用的实现。其中 `persist-pipeline.cjs`（连测试都没有）与 `layout-migrate.cjs` 处置成本最低，可先行。
3. **F3/F5 的活违规**（`src/server/tmux.cjs`/`host.cjs`/`bootstrap.sh` 收口到 adapters）属结构性，建议独立任务，不在本轮修复范围。
4. **F1/F2/F4/F8** 见 §六：待 N-2 处置后按各模块去留重新定性（若 `run-registry.cjs` 删除，F1/F2 随之消失）。

---

# 第 2 轮复审（T3-009 recheck 1）— 2026-09-11

> 复审对象：`T3-009-F1`（N-1/N-2/F7 处置）+ `T1-114`…`T1-119`（结构性补齐）后的**当前工作树**
> （未提交；基线 HEAD `e6385ec`）。按本模块验收口径**不跑整套真机**——真实运行验证由 `T3-011`（`--case all`）承担；
> 本轮全部结论取自第一手结构证据（命令输出 + 文件位置）。

## 八、上轮问题结清核对

| 上轮项 | 处置 | 本轮核验（第一手） | 判定 |
|---|---|---|---|
| **N-1** `coverage/` 34 个陈旧跟踪文件 | `T3-009-F1`：`git rm -r coverage` + `.gitignore` 补 `/coverage/` | `.gitignore` 末段 `/coverage/` 在位并附来源说明；`git status` 中 34 项已 staged 删除 | ✔ 结清 |
| **N-2** 6 个未接线抽象模块 | `T3-009-F1`：全部删除（含级联 `migrate.cjs`）+ 专属测试同删 | `grep` 生产侧（`src`/`scripts`/`plugin`/`web`）对 6 模块名**零命中**；`src/` 下已无对应文件 | ✔ 结清 |
| **N-3** `test:coverage` 缺依赖 | 未处置（环境项，非缺陷） | 维持 | 不计 |
| **F7** 契约标记失真 | `T1-116`：`impl` 布尔 → `status: 'factory' \| 'not-landed'` + 加载自检 | `ports.cjs` 名册自检；`ports-contract.test.js` 20 例 | ✔ 结清 |

**N-2 那一类缺陷已机器化拦住**（本轮最重要的一条）：`scripts/check-architecture.mjs` 不变量①「零生产引用」——
判据是「生产侧（`src`/`scripts`/`plugin`/`web/src`）零引用，**测试 import 不算被采用**」，正是 N-2 的判据本身。
本轮实测输出 `① 零生产引用模块：无`。上轮靠人对照 diff 才查出的东西，现在跑一次命令就拦得住。

## 九、验收点逐条对表（W3-009 WBS desc）

| # | 验收点 | 本轮第一手证据 | 判定 |
|---|--------|--------------|------|
| 1 | 全量测试适配新结构 | `npm test` **95 文件 / 844 例全绿**（EXIT 0）；删的测试与被删实现一一对应（`dashboard-shell`/`page-scope`/`layout-migrate`/`migrate`/`run-registry`/`server-app`/`server-api`/`session-launch`/`sid-naming`/`state-schema`/`statemachine` 随实现同删）；新增测试随新结构在册 | ✅ |
| 2 | 补齐组件级单测 | 本轮新结构对应的测试实测在册：`tests/unit/check-architecture.test.js`(28 例，守门禁自身)、`server-log.test.js`、`tests/integration/write-requires-project.test.js`、`tests/helpers/http-api.js`、`ports-contract.test.js`(20 例)；`pause.test.js` 随 T1-111 扩写 | ✅ |
| 3 | 自托管真 run 冒烟走完整新链路 | 注册表静态核验：**13 个 case**（`single gate multi decision dual resume pause recover pause-release init mcp lifecycle web`），数组顺序即 `--case all` 顺序，`--list` 可枚举；头部写明范围边界（plan 腿为交互式，headless 不覆盖）。**本轮不跑**（T3-011 的活） | ✅（边界已声明） |
| 4 | 架构纪律文字化写入审查 checklist | 三处齐备且同批三条：`code-review-architecture/SKILL.md`「架构纪律（逐条取证）」三条（依赖单向 / 隔离 / 事件 schema 版本）+「只写符合/不符合不算结论」；`w-review.md` 维度与输出要求 +「未取证的纪律不得计入 pass」；`code-architecture/SKILL.md` mirror | ✅ |
| 5 | 重构各模块过 code-review-architecture | `node scripts/check-architecture.mjs` **EXIT 0**：扫描 87 生产文件、白名单 3 条、豁免 4 条（零引用 **0** / 依赖方向 4），4 条 `responsible` 全指 `T1-113`；`--strict` EXIT 1（预期：4 条豁免未清）。审计报告 F1–F8 有结局附注、与门禁回写互不打架 | ✅（结论已收敛为「机器门禁 + 有主豁免」） |

**旁证**：`npm run build` **EXIT 0**（含 `render-config` + lint + `check:arch` + web 构建 + `npm pack --dry-run`）；`src/server/public/index.html`(321B) + `assets/index-*.js`(161.94kB) 实际产出；结构断言 `server.cjs ≤ 1600` 现状 **1491 行**（余量 109）。

## 十、本轮新发现

### N-4 · 真机 harness 的 case 自述与实现不符（模块内「自述失真」同类）

- 证据：`tests/regression/fullflow-regression.mjs` 头部 case 清单里 web 条仍写「**React 产物未构建时回落 legacy 观测页**」；
  而 `T1-119` 已把该行为改为「产物承载 / 未构建 → **503 + 告警**」，`caseWeb` 的实现与断言（`:1401-1404`）已是新语义。
- 影响：harness 是 W3-009「自托管真 run 冒烟」这一验收点的**证据来源**；其自述失真 = 读证据的人会按不存在的回落行为理解断言。
  与本模块 F6/F7 同类（契约/自述失真），也是 `code-review-architecture` 判据里「以实际行为为证据，不以注释自述代替」的反面样本。
- 严重度：**低**（行为正确，注释陈旧），一行可修。

### N-5 · `web/package-lock.json` 悬空决策（无主项）

- 证据：`git status` → `?? web/package-lock.json`；`git check-ignore` 无命中（未被忽略），`git ls-files` 未跟踪。
- 来源：`T1-118` 在 task result 里以「要不要入库由你定」上抛，**未走决策通道**，此后无 task 承接。
- 影响：`web/` 依赖解析不可复现（锁文件 `resolved` 指向本机 npmmirror）；与 T1-118 自己的动机（「前端从来装不上 / 构建不可复现」）方向相反。
- 严重度：**中低**。属需人裁决的仓策，门禁不代判——但「上抛未走通道 → 无主悬空」正是本模块要防的形态。
- **结清（T3-009-F2 / 2026-09-11，走决策通道）**：裁决 **入库**，已 `git add web/package-lock.json`（索引态 `A`）。
  决定性事实：根 `package-lock.json` **本就入库**（仓库既有约定 = 锁文件入库），且其 113 条 `resolved` **全部**指向
  `registry.npmmirror.com` —— npmmirror 绑定是**既存状态**，不是 web 锁文件引入的新问题；两份锁文件 `lockfileVersion` 同为 3、同源同形。
  故「据镜像 URL 而不入库」在收益上为零、在可复现性上为负，并破坏仓库自身约定。若日后切回公共 registry，应**同时**重生成两份锁文件。

### N-6 · 豁免表的责任任务可达性未保证（本轮最重）

- 证据：`EXEMPTIONS` 4 条全部 `responsible: 'T1-113'`；state 中 `T1-113.deps = ['T1-106']`、`T1-106.deps = ['T4-001']`；
  `T1-106` 的 acceptance 首句为「**【暂缓——用户 2026-09-10 裁定：互斥化还在考虑，现阶段统一走自动决策（新代门阀）】**」；
  `src/lib/state.js:75 depsDone` 判定 `dep.status === 'done'` 才算满足。
- 违反：`T1-113`（A server 分层 + D sid 贯通）与 `T1-106`（决策两条链互斥化）**无实质依赖**——排序把「架构补齐」绑在一条被明示暂缓的任务之后；
  一旦 T1-106 以 blocked 收场，`depsDone` 永不满足，4 条结构债（F3/F4/F5 活违规/F6）的**唯一责任人不可达**。
- 影响：这是上轮 N-2 的**镜像**——N-2 是「建了抽象没人接」，N-6 是「登记了责任人但走不到」。两者都会让
  「验证面/登记面成立、执行面落空」。**豁免表必须验的是可达性，不只是字段齐备**（现有单测只断言 reason+responsible 非空，拦不住这一类）。
- 严重度：**中**（不阻塞本模块验收，但阻塞 plan 级验收项「cc 一切收 adapter、外部源码零 claude 命令字面」的清偿）。改一个 deps 字段即可。

### 不判为 finding（已登记）

`T1-119` 在 result 里把 `docs/features/server.md` / `server.test.md` 的旧结构描述明确登记给 `T1-100`（pending，在图中）——属**已登记有人**，不计。

## 十一、结论（第 2 轮）

上轮两项 blocker（N-1 / N-2）**已结清**，且 N-2 那一类缺陷（抽象建了没人用）**已由 `check-architecture` 不变量①机器化拦住**——
这是本轮最有价值的进展：上轮靠人对照 diff 才查出的东西，现在跑一次命令就拦得住。模块五项验收点 **1–5 本轮全部第一手复核成立**。

非 pass 的原因**不在验收缺项**，而在**登记的完整性**：本模块产出的「证据（harness）/ 仓政策（锁文件）/ 豁免表」三处，
仍留有与实现不符或上抛后无人承接的条目——N-4（自述失真）、N-5（无主悬空项）、N-6（责任人可达性未保证）。
三者均属小改，且都属于本模块的主题：**验证与登记若与事实脱节，就等于没有**。

→ **verdict: changes_requested**

修复要求（按优先度）：

1. **N-6（一行，优先）**：解除 `T1-113 ← T1-106` 的非实质依赖，改挂实质前驱（`T3-011` / `T4-001`），使其在 A/D 立项时可实际就绪；
   并给「豁免表责任任务可达性」补一条断言（现有单测只验 reason/responsible 齐备，验不出可达性）。
2. **N-4（一行）**：harness 头部 web case 说明改为「产物承载 / 未构建 503 + 告警」二态。
3. **N-5**：`web/package-lock.json` 去留经决策通道裁决后落定（入库，或显式 `gitignore` + 一行理由），不留无主悬空项。
4. **不改**：F3/F4/F5/F6/F8 仍是 `T1-113` 的活，本轮维持豁免登记，不要求本模块内清偿。

---

# 第 3 轮复审（T3-009 recheck 2）— 2026-09-11

> 复审对象：`T3-009-F2`（第 2 轮三项处置）后的当前树。口径同前两轮：非真模块核查，
> 对照模块 acceptance 与改动 diff 做结构/验收自检；真机整套仍由 `T3-011` 承担。

## 十二、第 2 轮三项结清对表（全部第一手复核）

| 上轮项 | 处置（T3-009-F2） | 本轮核验 | 判定 |
|---|---|---|---|
| **N-6** 豁免责任任务可达性 | ① state：`T1-113.deps` → `['T4-001']` ② `check-architecture.mjs` 新增导出 `unreachableResponsibles()` ③ 单测 +8 例 ④ 文档四处 deps 表述同步 | ① 实测 `T1-113 deps = ['T4-001']` ② 直接调断言打真实图：`unreachable: []`，`blocked 任务数: 0` ③ 该文件 36 例全绿 ④ 全仓仅剩「更正附注」中的历史引用（`.awf/reports` 的历史记录不算） | ✔ 结清 |
| **N-4** harness 自述失真 | 头部 case 清单 + `caseWeb` 口径注释均改为二态 | `grep "legacy 观测页"` 全仓仅 3 处命中，**全部是「已退役」语义**（harness 两处改写后的新表述、`server.cjs:881` 实现注释）；无一处再声称回落 | ✔ 结清 |
| **N-5** 锁文件无主悬空 | 走决策通道裁决「入库」，`git add` | `git status` → `A  web/package-lock.json`；`git ls-files` 命中；不再处于「既不在库也不被忽略」的第三态 | ✔ 结清 |

**两条从「提醒」升级成了机器出口**（本模块的主题）：
- 可达性不再是「记得看」——`unreachableResponsibles()` 的判据直接取自 `src/lib/state.js:depsDone`，
  并有一条单测**打真实 `.awf/state.json`**；非实质依赖仍判不出（已写明是必要条件、非充分条件）。
- 自述与实现的偏离由本轮起被 `check-architecture` 的口径覆盖（`code-review-architecture` 的依赖单向检查项已含
  「计算路径引用是字面扫描死角」「不以注释自述代替证据」两条，见 T1-099 的审计报告）。

## 十三、验收点复核（较第 2 轮的变化）

| # | 验收点 | 第 3 轮证据 | 判定 |
|---|--------|-----------|------|
| 1 | 全量测试适配新结构 | `npm test` **95 文件 / 852 例全绿**（第 2 轮 844 → +8，全部来自新增的可达性断言） | ✅ |
| 2 | 补齐组件级单测 | 同上；本轮新增的断言本身即组件级单测（纯函数 + 真实图两条粒度） | ✅ |
| 3 | 自托管真 run 冒烟走完整新链路 | **已由 `T3-011` 实跑**：13 个 case × 150 断言，两轮完整跑（145/150、146/150），所有真链路断言按预期收敛；本模块的「注册表可扩展 + 双入口 + 证据落盘」在该轮被实际使用并暴露了 harness 自身的 case 隔离缺陷 | ✅（缺陷已有主：见下） |
| 4 | 架构纪律文字化入 checklist | 未变（三处齐备，见 §九） | ✅ |
| 5 | 重构各模块过 code-review-architecture | `node scripts/check-architecture.mjs` **EXIT 0**：87 生产文件、白名单 3、豁免 4（零引用 **0** / 依赖方向 4，`responsible` 全指 `T1-113`）；`--strict` EXIT 1 为预期（4 条未清） | ✅ |

旁证：`npm run build` EXIT 0（含 `render-config` + lint + `check:arch` + web 构建 + `npm pack --dry-run`）；
`npm run test:real -- --list` 列出全部 13 个 case。

## 十四、与 T3-011 的关系（不重复计Finding）

`T3-011` 的全量真机门禁判 `changes_requested`，失败 4 条稳定 + 1 条间歇，**全部归因为 case 侧**
（`pause-release`/`pause` 依赖 server 为本 case 派生、`init` 幂等断言与 `--port` 隔离口径冲突、
`decision` 间歇）。这些缺陷属 **harness 的 case 隔离性**，已有责任任务 `T3-011-F1`（pending，在图中），
**本模块不重复登记**；`docs/discuss/real-run-coverage-gaps.md` 已新增第 17 条缺口记录该形态。

## 十五、已知边界（记录，不判Finding）

- `unreachableResponsibles()` 目前**只有单测消费**，未接进 `npm run build` —— 这是**有意**的：构建不该因运行态里
  有任务 blocked 而变红。若将来希望它在门禁任务里被直接调用（例如由某个 `kind=test` 任务拿它出证据），
  应显式加一个只读入口，而不是接进构建链。
- 非实质依赖（「A 其实用不着等 B」）机器判不出，仍需人审；`T3-009` 第 3 轮已把这条写进函数注释，
  免得它被当成万能判据。

## 十六、结论（第 3 轮）

第 2 轮三项（N-4 / N-5 / N-6）**全部结清**，且其中两项补上了机器出口：可达性有了打真实任务图的断言，
自述失真有了对照实现的口径；第三项经决策通道落成文件上的确定态。
模块五项验收点 **1–5 本轮全部成立**（第 1 项目测数由真机门禁 `T3-011` 实证支撑）。
本轮**未发现新的登记与事实脱节**；`F3/F4/F5/F6/F8` 维持 `T1-113` 豁免且责任人经本轮修复后**可达**，
两条已知边界已如实记录。

→ **verdict: pass**

