# .awf (v0.0.1)

ai-workflow 运行时目录，承载版本状态、Issue 跟踪、Bug 记录、报告产出、运行日志。

## 目录结构

```
.awf/
├── state.json              # 当前运行时状态（awf run 读写）
├── versions/               # 版本归档
│   └── v0.1.x/state.json   #   各版本的完整状态快照
├── issues/                 # Issue 跟踪（等价于 GitHub Issues）
│   └── TEMPLATE.md         #   新建 Issue 模板
├── bugs/                   # 运行时缺陷记录
│   └── TEMPLATE.md         #   新建 Bug 模板
├── reports/                # 测试/审查/lint/汇总报告
│   ├── test/               #   测试报告（按版本分目录）
│   ├── review/             #   审查报告（按版本分目录）
│   ├── lint/               #   Lint 报告（按版本分目录）
│   └── summary/            #   里程碑汇总报告
└── logs/                   # awf run 全量运行日志
    └── YYYY-MM-DD-HHmmss/  #   按运行时间分目录
```

---

## 各目录说明

### versions/ — 版本归档

每个版本一个文件夹，内含该版本的完整 `state.json`。版本结束后不再修改，git 作为历史追溯。

### issues/ — Issue 跟踪

承担与 GitHub Issues 相同的功能：缺陷、待办、讨论、决策等跟踪事项。每个文件一个 Issue，YAML frontmatter + Markdown 正文。

**命名**：`NNN-short-slug.md`（NNN 三位递增编号）

**Frontmatter 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 三位编号，如 `"001"` |
| `title` | `string` | Issue 标题 |
| `status` | `enum` | `open` / `in_progress` / `resolved` / `wontfix` / `duplicate` |
| `labels` | `string[]` | `bug` / `feature` / `enhancement` / `discussion` / `question` / `blocked` |
| `assignee` | `string\|null` | 负责人 |
| `milestone` | `string\|null` | 关联里程碑，如 `v0.1.4` |
| `priority` | `enum` | `low` / `medium` / `high` / `critical` |
| `created` | `date` | 创建日期 |
| `updated` | `date` | 最后更新日期 |
| `deps` | `string[]` | 依赖的其他 Issue ID |
| `related` | `string[]` | 关联的 task id / wbsRef |

**状态流转**：`open → in_progress → resolved`（可旁路到 `wontfix` / `duplicate`）

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

**命名**：`NNN-short-slug.md`

**Frontmatter 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 三位编号 |
| `title` | `string` | Bug 标题 |
| `status` | `enum` | `open` / `confirmed` / `in_fix` / `resolved` / `wontfix` |
| `severity` | `enum` | `critical` / `high` / `medium` / `low` |
| `source.task_id` | `string` | 发现时正在执行的任务 |
| `source.milestone` | `string` | 所属里程碑 |
| `source.phase` | `string` | 发现时所在阶段（DEV/TEST/REVIEW/COMMIT） |
| `labels` | `string[]` | 标签 |
| `created` | `date` | 创建日期 |
| `resolved` | `date\|null` | 解决日期 |

**状态流转**：`open → confirmed → in_fix → resolved`（可旁路到 `wontfix` / `duplicate`）

**正文**：现象 → 复现步骤 → 根因分析 → 修复方案 → 关联

Bug 确认需要跨任务跟踪时，在 `issues/` 中创建对应 Issue，通过 `related` 字段双向关联。

---

### reports/ — 报告产出

`awf run` 各阶段产出的报告，按类型和版本分目录。

| 子目录 | 阶段 | 内容 |
|--------|------|------|
| `test/` | TEST | 测试报告（feature / impacted / full_regression） |
| `review/` | REVIEW | 审查报告（code / security / ui / architecture） |
| `lint/` | DEV/REVIEW | Lint 检查报告 |
| `summary/` | FINISH | 里程碑汇总报告 |

**文件命名**：`<task-id>-<slug>.md`，summary 为 `summary.md`

**通用 Frontmatter**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `enum` | `test` / `review` / `lint` / `summary` |
| `task_id` | `string\|null` | 关联任务 ID |
| `milestone` | `string` | 所属里程碑 |
| `result` | `enum` | `pass` / `fail` / `partial` / `changes_requested` |
| `created` | `date` | 创建日期 |

各类型附加字段见模板。

---

### logs/ — 运行日志

每次 `awf run` 的全量记录，按运行时间分目录。

```
logs/
└── 2026-07-31-143052/      # 运行时间戳
    ├── run.log             #   完整终端输出
    ├── phases.json         #   阶段执行记录
    ├── errors.json         #   错误/异常汇总
    └── metrics.json        #   耗时/token/轮次等指标
```

**目录命名**：`YYYY-MM-DD-HHmmss`（启动时间）

| 文件 | 内容 |
|------|------|
| `run.log` | stdout + stderr 完整输出 |
| `phases.json` | 各阶段起止时间、状态、产出 |
| `errors.json` | 异常堆栈、上下文、恢复动作 |
| `metrics.json` | 总耗时、token 消耗、对话轮次、任务数 |
