# Issues — v0.1.3

> 来源：`docs/discuss/architecture-v0.1.3.md`

## init

### 001 — CLAUDE.md 自动生成与注入
`init` `v0.1.3`

`awf init` 执行时自动处理项目 CLAUDE.md：不存在→模板生成+注入 / 存在无标记→追加注入 / 已有标记→跳过。注入源 `templates/awf-rules.md`，以 `<!-- awf-rules -->` 包裹。

### 002 — .awf/ state 拆分
`init` `plan` `v0.1.3`

单一 state.json 拆为：`state.json`（总纲+taskOrder）+ `wbs.json`（树+flatMap）+ `tasks/<id>.json`（task 详情）。

## plan

### 003 — engine / profile / tools 三层解耦
`plan` `refactor` `v0.1.3`

run.js 中决策逻辑分离：engine/（执行引擎）、profile/（规则配置）、tools/（MCP 能力，不动）。本期只保留 programming profile。

### 004 — WBS 树结构 + 9-level 层级体系
`plan` `v0.1.3`

扁平 WBS → 树结构。启用 5 级：task(无门禁)、function(无)、module(REVIEW)、requirement(REVIEW+TEST+COMMIT+DOCS)。上层预留本期不做。

### 005 — 后序遍历 + 门禁插入算法
`plan` `algorithm` `v0.1.3`

DFS 后序：叶子(task)→生成 dev task / 节点有门禁→插入 gate task(scope=子孙 id)。产出扁平可执行列表。

### 006 — Prompt 预生成
`plan` `v0.1.3`

plan 阶段预生成每个 task 的 prompt 存入 `.awf/tasks/<id>.json`。DEV 首期用 desc 原样，GATE 用 profile 模板拼装。

### 007 — 门禁规则配置化
`plan` `config` `v0.1.3`

`profile/programming/levels.yaml`（级别→门禁映射）+ `phases.yaml`（阶段链）。本期只保留 programming profile。

## run

### 008 — run 退化为纯 task 迭代器
`run` `refactor` `v0.1.3`

删除 resolvePhases() 和 buildMcpFollowUp()。runLoop 变成纯迭代器：读 taskOrder → POST /send → waitForReady。

### 009 — Gate task 执行机制
`run` `v0.1.3`

type='gate' 的 task 含 gateType 和 scope。run 遇 gate task → POST /send 预生成 prompt → AI 执行门禁(REVIEW/TEST/COMMIT/DOCS) → MCP 更新状态。

### 010 — 命令双模式检测
`run` `v0.1.3`

slash command 启动时检测 awf-run 模式（MCP + .awf/）。awf-run 模式自主执行+写 state，普通模式交互确认+仅输出。

### 011 — No-Arg 无参数默认行为
`run` `ux` `v0.1.3`

除 dev 外，无参数时根据上下文推算：/w-review→审查当前 task files，/w-commit→提交当前变更，/w-debug→读取失败 task 错误等。

### 012 — 异常重试 + 暂停机制
`run` `reliability` `v0.1.3`

失败→自动重试 2 次→仍失败标记 blocked→暂停 run→保存进度→等待人工介入。

### 013 — 运行日志 + Token 记录
`run` `observability` `v0.1.3`

`.awf/logs/<session-id>/` 按 task 记录 request.md + response.md。Token 消耗记录并 Dashboard 展示，不做硬限制。
