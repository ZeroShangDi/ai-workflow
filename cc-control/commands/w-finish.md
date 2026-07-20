# 里程碑收尾

当前里程碑开发完成后的收尾工作。**w-finish 不是项目终点，而是阶段性结束标识**——一个复杂任务会经过多次 FINISH。

## 参数

`$ARGUMENTS` — 可选，指定执行的收尾项（逗号分隔）。留空则全部执行。

可选项：`quality`（代码质量）/ `perf`（性能分析）/ `doc`（文档同步）/ `summary`（开发总结）/ `memory`（记忆提取）/ `handoff`（交接准备）

示例：
- `/w-finish` — 执行全部收尾
- `/w-finish quality,perf` — 只做质量和性能检查
- `/w-finish handoff` — 只做交接准备（里程碑切换时）

## 前置 Skill 调用

自动调用 `superpowers:verification-before-completion` — 确认改动正确后再收尾。

## 关联 Skill

收尾检查以 **quality-standards** skill 为质量标准。

## 执行流程

### 1. 代码质量检查（quality）

- 运行 `pnpm lint` 确认无 lint 错误
- 运行 `pnpm typecheck` 确认无类型错误
- 检查 `src/sidepanel/Layout.vue` 第 9~11 行的注释状态（打包前必须删除）
- 检查是否有遗留的 `console.log`、`debugger`、`TODO` 等调试代码
- 检查是否有未使用的 import 或变量

### 2. 性能分析（perf）

审查本次里程碑变更中可能存在的性能问题（仅限本次变更范围，不做全局扫描）。

### 3. 文档同步（doc）

- 检查涉及模块是否有对应 `docs/` 下的需求文档
- 对比代码变更与文档，判断是否需要更新
- 如需更新，执行 `/w-doc <module>/<req-id>` 增量更新
- 全新模块提示是否需要执行 `/w-doc <module>`

### 4. 开发总结（summary）

```
## 里程碑总结 — [里程碑名称]

### 变更范围
- 修改文件：X 个 / 新增文件：X 个

### 关键改动
1. [改动点] — [目的]

### 需求完成情况
- ✅ 已完成：X 项
- ⚠️ 延后：X 项（原因）

### 下一里程碑
[简要描述 or 「项目完成」]
```

### 5. 记忆提取（memory）

提取值得跨会话持久化的信息，写入 memory 系统。只提取**未来对话中有用**的信息。

### 6. 交接准备（handoff）

里程碑切换时执行：

- **版本控制**：确认所有变更已提交（如有未提交的，提示先执行 `/w-commit`）
- **上下文清理**：检查并清理 `/temp/` 中的临时文件
- **状态更新**：更新 `.claude/awf-state.json` 中里程碑状态
- **Issue 检查**：扫描 `.claude/issues/`，汇总待决策 Issue
- **交接摘要**：输出下一里程碑的启动上下文

## 注意

- 如有未提交变更，提示先执行 `/w-commit`
- 性能分析只针对本次变更代码
- 文档同步只更新已有文档，不主动创建新文档
- 记忆提取遵循 memory 系统规范
