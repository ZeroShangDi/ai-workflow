# .awf (v{{VERSION}})

ai-workflow 运行时目录，承载版本状态、Issue 跟踪、Bug 记录、报告产出、运行日志。

## 目录结构

```
.awf/
├── state.json              # 当前运行时状态（awf run 读写）
├── context/
│   ├── architecture.md     # 项目架构事实、模块职责和扩展方式
│   └── handoff.md          # 上下文压缩时生成的会话接力快照
├── versions/               # 版本归档（每次 run 完成一份 state 快照）
│   └── <version>-<timestamp>.json
├── issues/                 # Issue 跟踪（等价于 GitHub Issues）
│   └── NNN-short-slug.md   #   一文件一 Issue（YAML frontmatter）
├── bugs/                   # 运行时缺陷记录
│   └── <slug>.md           #   一文件一 Bug（不编号，元数据块在标题下）
├── decisions/              # AI 运行期决策记录（供人复盘）
│   └── runs/*.jsonl        #   按 run 追加（不拆单文件）
├── dynamic-planning/       # 运行期局部计划调整 proposal 与事件
│   ├── proposals/          #   可批准、可冲突恢复的完整 proposal
│   └── events.jsonl        #   追加式生命周期记录（首次使用时生成）
├── reports/                # 测试/审查/性能/lint/汇总报告
│   ├── test/               #   测试报告（按版本分目录）
│   ├── review/             #   审查报告（按版本分目录）
│   ├── perf/               #   性能分析报告
│   ├── lint/               #   Lint 报告（按版本分目录）
│   └── summary/            #   里程碑汇总报告
└── logs/                   # awf run 全量运行日志 + 跨 run 顶层文件（见 §logs）
    └── {version}-{ts}/     #   每次 run（main.log + agents/）
```

---

## context/ — 跨任务工程上下文

`architecture.md` 保存已经由代码或团队决策确认的架构事实，供不同任务和 Agent 复用。只有模块职责、依赖方向或公共扩展方式真正变化时更新，不记录任务流水账。`handoff.md` 是上下文压缩时生成的临时接力快照。

---

## 各目录说明

### versions/ — 版本归档

每次 `awf run` 走完（FINISH 收尾调 `backupState`）快照一份当时的 `state.json`，落成**扁平文件** `versions/<version>-<timestamp>.json`（如 `0.2.0-2026-09-10T08-31-17.json`），**不建「每版本一个文件夹」**。快照写入后不再修改，git 作为历史追溯。

### issues/ — Issue 跟踪

承担与 GitHub Issues 相同的功能：缺陷、待办、讨论、决策等跟踪事项。每个文件一个 Issue，YAML frontmatter + Markdown 正文。

**命名**：`NNN-short-slug.md`（NNN 三位递增编号）

**Frontmatter 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 三位编号，如 `"001"` |
| `title` | `string` | Issue 标题 |
| `status` | `enum` | `open` / `in_progress` / `resolved` / `wontfix` / `duplicate` |
| `labels` | `string[]` | **自由标签，不做枚举**：建议优先取 `bug` / `discussion` / `tooling` / `blocked`，领域词（`eval` / `recovery` / `real-run` …）按需新增 |
| `assignee` | `string\|null` | 负责人 |
| `milestone` | `string\|null` | 关联里程碑，如 `v0.1.4` |
| `priority` | `enum` | `low` / `medium` / `high` / `critical` |
| `created` | `date` | 创建日期 |
| `updated` | `date` | 最后更新日期 |
| `deps` | `string[]` | 依赖的其他 Issue ID |
| `related` | `string[]` | 关联的 task id / wbsRef |

**状态流转**：`open → in_progress → resolved`（可旁路到 `wontfix` / `duplicate`）

> **为什么 `labels` 不做枚举**：标签是**检索维度**，维度会随项目演进而增长 —— 本仓实际已用到 `tooling` / `eval` / `legacy` / `real-run` / `observability` 等领域词，枚举里没有对应项。钉死词表只会逼出两种坏结果：硬塞一个语义不符的枚举值，或让规范与实际长期打架。核心集是**起点**，不是边界。

**查询**：
```bash
grep -l "status: open" .awf/issues/*.md         # 按状态
grep -l "labels:.*bug" .awf/issues/*.md          # 按标签
grep -l "milestone: v0.1.4" .awf/issues/*.md     # 按里程碑
```

与 GitHub Issues 的关系：本地 Issue 先在此记录，确认需要协作/跨团队跟踪时再同步到 GitHub。

---

### bugs/ — 运行时缺陷

`awf run` 执行过程中产出的缺陷记录。与 `issues/` 的区别：bugs 是运行时自动或半自动产出的缺陷事实，issues 是需要跟踪管理的所有事项。

**命名**：`<slug>.md`（kebab-case，取自缺陷本身；**不编号**）

> **为什么 bugs 不编号**：issues 是人工建立的跟踪项，编号是它的自然主键（顺序分配、`related` 互引，与 GitHub 一致）；bugs 由 run 运行期产出，没有中央分配器 —— 写记录的一方必须先扫目录，多分支并行还会撞号。slug 自描述、可并发产出、合并无冲突。

**元数据块**：首行 `# <一句话标题>` 之后紧跟一段无序列表（每行 `- <键>: <值>`）。常用键：

| 键 | 必填 | 说明 |
|------|------|------|
| `状态` | 是 | **自由文本，不设枚举**。一句话说清「修到哪一步」，可含时点。例：`fixed（2026-09-12，T3-010-F1 收尾时暴露）`、`部分实现（2026-09-10）——已实现 A、B，未实现 C`、`open` |
| `类型` | 否 | 缺陷归类，如 `awf 产品缺陷（运行/等待超时语义）` |
| `严重度` | 否 | `critical` / `high` / `medium` / `low`，可附一句影响 |
| `发现` | 否 | 发现时点与场景；时点亦可写在 `状态` 里，二者有其一即可 |
| `关联` | 否 | 任务 ID / Issue / 代码路径 |

键可按需增补（如 `基线` / `触发`）。**只写有证据的字段，宁缺毋造。**

**状态为什么不做枚举**：bugs 的价值是「当时到底修到哪一步」的第一手事实；枚举会逼记录者在信息不足时二选一，反而制造失真。与 `issues/` 的枚举制差异是**刻意**的 —— 后者是需要跟踪管理的事项，前者是运行期事实。

**正文**：`## 现象` → `## 根因` → `## 修复 / 处置` → `## 关联`

Bug 确认需要跨任务跟踪时，在 `issues/` 中创建对应 Issue 并双向关联（bugs 无编号，从 Issue 侧按路径引用）。

---

### decisions/ — AI 运行期决策

`awf run` 运行过程中 AI 做出的辅助决策记录，供人**运行后复盘**查看，与人为决策（`docs/discuss/`）分开。

**落点**：`decisions/runs/<runStamp>.jsonl`（一次 run 一个文件，追加式；`runStamp` 与 `.awf/logs/` 对齐，如 `0.2.0-2026-09-10T14-21-09`）。由 `src/server/decision-store.cjs` 写入，**不按「一决策一文件」拆分**。

**不变量**：只追加、绝不覆盖历史；同一 `decision_id` 在同一 run 文件内不重复落盘；`override` 以追加事件写入原 decision 所在文件。

### dynamic-planning/ — 动态任务规划

保存运行期局部任务调整的 proposal 与追加事件。`run.dynamicPlanning.mode` 决定安全调整是自动应用后复审，还是人工批准后应用；删除任务、删除依赖和改变目标字段会建立正式 decision，必须由人工 resolve 后才应用或拒绝。

---

### reports/ — 报告产出

`awf run` 各阶段产出的报告，按类型和版本分目录。

| 子目录 | 阶段 | 内容 |
|--------|------|------|
| `test/` | TEST | 测试报告（feature / impacted / full_regression） |
| `review/` | REVIEW | 审查报告（code / security / ui / architecture） |
| `perf/` | REVIEW | 性能分析报告 |
| `lint/` | DEV/REVIEW | Lint 检查报告 |
| `summary/` | FINISH | 里程碑汇总报告 |

**文件命名**：`<task-id>-<slug>.md`，summary 为 `summary.md`

**通用 Frontmatter**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `enum` | `test` / `review` / `perf` / `lint` / `summary` |
| `task_id` | `string\|null` | 关联任务 ID |
| `milestone` | `string` | 所属里程碑 |
| `result` | `enum` | `pass` / `fail` / `partial` / `changes_requested` |
| `created` | `date` | 创建日期 |

各类型附加字段见模板。

---

### logs/ — 运行日志

每次 `awf run` 的全量记录，按运行版本与启动时间分目录；另有几个跨 run 的顶层文件。

```
logs/
├── 0.1.3-2026-07-31T14-30-52/  # 运行版本与启动时间
│   ├── main.log                 # 主 Agent 可读日志
│   └── agents/                  # 每个子 Agent 的可读日志
│       └── T1--agent-id.log
├── server.log                   # 常驻 server 的 stdout/stderr（T1-112）
├── hook-gateway.log             # hook 网关留痕（失败必留一行，SessionStart 成功也留一行）
├── subagent-events.jsonl        # 子 Agent 生命周期事件（追加）
└── run-meta.json                # 当前 run 元信息
```

**目录命名**：`{version}-YYYY-MM-DDTHH-mm-ss`（运行版本与启动时间）

| 文件 | 内容 |
|------|------|
| `main.log` | 主 Agent 的可读提示词与回答日志 |
| `agents/<taskId>--<agentId>.log` | 对应子 Agent 的时间顺序可读日志；重试会保留独立文件 |
