---
name: awf-task-model
description: >
  Task data schema — the canonical definition of every task field in .awf/state.json.
  Who reads it, who writes it, and when. Referenced by w-plan, awf-run, w-dev, w-review,
  w-test, w-commit, and w-finish.
---

# AWF Task Model — Canonical Task Schema

This skill defines the task object stored in `plan.tasks[]` inside `.awf/state.json`. Every command that touches a task MUST respect the read/write boundaries defined here.

## Task Object

```json
{
  "id": "1",
  "desc": "实现登录表单组件",
  "prompt": "在 src/components/LoginForm.vue 中创建邮箱+密码登录表单...",
  "wbsRef": "1.1",
  "deps": [],
  "status": "pending",

  "exec": {
    "result": null,
    "files": []
  },

  "commits": []
}
```

## Field Specification

### Layer 1 — Execution-critical fields

| Field | Type | Writer | Phase | Description |
|-------|------|--------|-------|-------------|
| `id` | `string` | w-plan | PLAN | Unique task identifier within the milestone |
| `desc` | `string` | w-plan | PLAN | Human-readable one-liner — what this task is |
| `prompt` | `string` | w-plan | PLAN | AI-facing development instruction — how to implement it. Written once at plan time, never modified by downstream phases. |
| `wbsRef` | `string` | w-plan | PLAN | Back-reference to WBS node id, e.g. `"1.1"` |
| `deps` | `string[]` | w-plan | PLAN | Task ids this task depends on. Empty array = immediately runnable |
| `status` | `enum` | CODE/DEBUG | CODE | State lifecycle: `pending` → `active` → `done` / `blocked` |

**`desc` vs `prompt`**:
- `desc` is for humans scanning the task list — keep it short
- `prompt` is what gets injected into the AI context when executing the task — include file paths, constraints, expected behavior

### Layer 2 — Execution result (`exec`)

Written by CODE phase after task implementation.

| Field | Type | Description |
|-------|------|-------------|
| `exec.result` | `string\|null` | Summary of what was done, decisions made, known limitations |
| `exec.files` | `string[]` | Files created or modified during this task |

COMMIT phase reads `exec.files` to scope the commit. REVIEW and TEST phases read `exec.result` for context.

### Layer 2 — Commit log (`commits`)

Appended by COMMIT phase. One task may produce multiple commits.

| Field | Type | Description |
|-------|------|-------------|
| `commits[].hash` | `string` | Full commit SHA |
| `commits[].message` | `string` | Conventional Commit message |

### Status Lifecycle

```
pending ──→ active ──→ done
  │                     │
  └──→ blocked ←───────┘
```

| Transition | Trigger |
|------------|---------|
| `pending` → `active` | awf-run picks this task for CODE phase |
| `active` → `done` | w-commit completes successfully |
| `active` → `blocked` | External dependency, needs human decision (create Issue) |
| `blocked` → `pending` | Issue resolved, task re-enters queue |
| `done` → `active` | (rare) Post-review rework needed, reopened by w-review |

## Deferred Fields

The following fields are defined but NOT in use for the current milestone. Keep their slots reserved.

```json
{
  // "parallel": false
}
```

| Field | Purpose | Deferred because |
|-------|---------|-----------------|
| `parallel` | Mark task as safe for concurrent execution with other `[P]` tasks | Multi-threaded execution not in scope |

The `conversation` object (multi-turn prompt history per task) is under design and not yet included in the schema. Its slot will be a top-level `conversation` field added later.

## Phase Read/Write Matrix

| Phase | Reads | Writes |
|-------|-------|--------|
| **PLAN** | — | `id`, `desc`, `prompt`, `wbsRef`, `deps`, `status = "pending"` |
| **CODE** | `id`, `desc`, `prompt`, `deps`, `status` | `status`, `exec.result`, `exec.files` |
| **REVIEW** | `desc`, `exec.result`, `exec.files` | (reports to state, does not write tasks directly) |
| **TEST** | `desc`, `exec.result` | (sets `canCommit`, does not write tasks directly) |
| **COMMIT** | `status`, `exec.result`, `exec.files` | `status = "done"`, `commits[]` |
| **DEBUG** | `desc`, `exec.files`, `exec.result` | `status` (may revert to `active`) |
| **FINISH** | all tasks' `status` | — |
