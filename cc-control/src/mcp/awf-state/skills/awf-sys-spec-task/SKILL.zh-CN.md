---
name: awf-sys-spec-task
description: >
  任务数据模型 — .awf/state.json 中 task 对象的权威字段定义。
  谁读、谁写、什么时候。被 w-plan、awf-run、w-dev、w-review、w-test、w-commit、w-finish 引用。
---

# AWF 任务模型

## Task 对象

```json
{
  "id": "T2-001",
  "desc": "实现登录表单",
  "prompt": "在 src/components/LoginForm.vue 中创建登录表单...",
  "wbsRef": "W2-001",
  "deps": [],
  "status": "pending",
  "exec": { "result": null, "files": [] },
  "commits": []
}
```

id 遵循编号规范 `{前缀}{级别}-{序号}`（见 w-plan 的编号规范章节）：`W`=WBS 节点、`T`=任务，级别=树深度（顶层模块=1），序号=同级内 3 位补零递增。任务 `T{级别}-{序号}` 与对应 WBS 节点 `W{级别}-{序号}` 序号对齐，`wbsRef` 指向同级别的 WBS 节点 id。

## 字段规范

### 第一层 — 执行关键字段

| 字段 | 类型 | 写入方 | 说明 |
|------|------|--------|------|
| `id` | string | w-plan | 里程碑内唯一标识 |
| `desc` | string | w-plan | 人类可读的一句话描述 |
| `prompt` | string | w-plan | AI 开发指令，规划时写入，后续只读 |
| `wbsRef` | string | w-plan | 关联 WBS 节点 |
| `deps` | string[] | w-plan | 依赖的任务 id，空数组 = 可立即执行 |
| `status` | enum | CODE/DEBUG | pending → active → done / blocked |

**desc vs prompt**：desc 给人看，要短；prompt 给 AI 看，要包含路径、约束、预期行为。

### 第二层 — 执行结果 (exec)

| 字段 | 说明 |
|------|------|
| `exec.result` | 做了什么、做了什么决策、已知限制 |
| `exec.files` | 本次任务创建或修改的文件 |

### 第二层 — 提交日志 (commits)

| 字段 | 说明 |
|------|------|
| `commits[].hash` | 提交 SHA |
| `commits[].message` | Conventional Commit 消息 |

## 状态流转

```
pending → active → done
  │                 │
  └──→ blocked ←────┘
```

| 流转 | 触发 |
|------|------|
| pending → active | awf-run 选中此任务进入 CODE |
| active → done | w-commit 成功完成 |
| active → blocked | 外部依赖，需人工决策 |
| blocked → pending | Issue 解决，重新入队 |

## 延迟字段

以下字段已定义但本期未使用：

| 字段 | 延迟原因 |
|------|----------|
| `parallel` | 多路并行不在本期范围 |

## 阶段读写矩阵

| 阶段 | 读 | 写 |
|------|-----|-----|
| PLAN | — | id, desc, prompt, wbsRef, deps, status=pending |
| CODE | id, desc, prompt, deps, status | status, exec.result, exec.files |
| REVIEW | desc, exec.result, exec.files | 不直接写 |
| TEST | desc, exec.result | 设 canCommit，不直接写 |
| COMMIT | status, exec.result, exec.files | status=done, commits[] |
| DEBUG | desc, exec.files, exec.result | status（可能回 active） |
| FINISH | 全部 task.status | — |
