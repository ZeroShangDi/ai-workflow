---
name: awf-spec
description: >
  Autonomous workflow specification — state machine model, phase definitions, state persistence,
  issue escalation, and autonomous decision rules for the awf-run system. Referenced by awf-run
  command and w-finish. Use when implementing or modifying the workflow pipeline itself.
---

# AWF Specification — Autonomous Workflow Engine

This skill defines the complete specification of the autonomous workflow system. The `awf-run` command invokes this skill; it does not inline these details.

## State Machine

```
                              ┌──────────────────────────┐
                              │          PLAN            │
                              │  Q&A → 需求文档 → 原型    │
                              │  → WBS → 任务清单        │
                              └────────────┬─────────────┘
                                           │
                         ┌─────────────────┼─────────────────┐
                         │ 无 UI            │ 有 UI            │ 简单任务
                         ▼                 ▼                  │
                   ┌──────────┐    ┌──────────────┐           │
                   │   CODE   │    │    DESIGN    │           │
                   │ loop 逐个 │    │ 3 风格 → 选一 │           │
                   │ 执行任务  │    │ → 逐步生成 UI │───────────┘
                   └────┬─────┘    └──────┬───────┘
                        │                 │ UI 就绪
                        │◀────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │ 遇到 bug      │ 任务完成      │ 阶段性完成
         ▼               ▼              ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  DEBUG   │   │  REVIEW  │   │  FINISH  │ ← 里程碑标识
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        │               │              │
        │ 定位根因       │ 审查通过      │ 下一里程碑
        ▼               ▼              ▼
     回 CODE      ┌──────────┐   回 PLAN / CODE
                  │   TEST   │
                  └────┬─────┘
                       │
            ┌──────────┼──────────┐
            │ 代码缺陷   │ 测试通过   │ 文档过期
            ▼           ▼           ▼
       回 CODE/DEBUG ┌──────────┐ ┌──────────┐
                     │  COMMIT  │ │   DOC   │ ← 任意节点可触发
                     └────┬─────┘ └────┬─────┘
                          │              │
                          ▼              │ 更新完成
                     ┌──────────┐        │
                     │  FINISH  │◀───────┘
                     └──────────┘
```

## Key Rules

- **DOC triggers anywhere** — not fixed to a position; before/after coding or during testing
- **FINISH = milestone marker** — not project end; complex tasks go through multiple FINISH cycles
- **DEBUG is interrupt-driven** — triggered when any phase (CODE/REVIEW/TEST) encounters an issue
- **TEST → DOC automatic** — stale docs detected during testing auto-trigger `/w-doc`, then re-test
- **Multiple COMMITs allowed** — a requirement can be committed once or multiple times per milestone

## Document System

| Level | Content | Location | Phase |
|-------|---------|----------|-------|
| Project | Requirements doc, prototype, WBS, task list | `docs/<feature>.md` | PLAN |
| Requirement | Requirement doc `.md` | `docs/<module>/<req-id>.md` | CODE |
| Requirement | Test cases `.test.md` (721 pyramid) | `docs/<module>/<req-id>.test.md` | CODE |
| Requirement | Dev log `.log.md` | `docs/<module>/<req-id>.log.md` | CODE |
| Temp | Review results | `temp/` (deletable anytime) | REVIEW/TEST |

## State Persistence

State written to `.claude/awf-state.json` on every state transition, task completion, and Issue creation.

```json
{
  "task": "original task description",
  "currentState": "CODE",
  "currentMilestone": 1,
  "plan": {
    "reqDoc": "docs/<feature>.md",
    "wbs": [{ "id": "1", "deliverable": "...", "acceptance": "...", "deps": [] }],
    "tasks": [{ "id": "1", "desc": "...", "wbsRef": "1.1", "deps": [], "parallel": false, "status": "done" }]
  },
  "milestones": [{ "id": 1, "desc": "...", "status": "active" }],
  "lastUpdated": "2026-06-29T10:00:00Z"
}
```

**Recovery**:
1. `/awf-run --resume` or new `/awf-run` detects existing state file
2. Shows: last interrupt position + progress summary + pending Issues
3. User chooses: continue / restart

## Phase Details

### PLAN — Requirements alignment

1. Analyze task, explore codebase
2. Interactive Q&A (AskUserQuestion), 1-3 questions at a time
3. Output sequentially: requirements doc → prototype → WBS → task list
4. Confirm with user before proceeding
5. If UI involved → enter DESIGN; pure logic → enter CODE

### DESIGN — UI style selection (optional)

Triggered when PLAN marks "requires DESIGN phase":
1. Read `.claude/user/style-preferences.md` for historical preferences
2. Generate 3 visually distinct style proposals
3. User selects one via AskUserQuestion
4. Save to `.claude/user/style-preferences.md`
5. Generate UI incrementally — one page/component at a time, confirming each
6. UI ready → enter CODE

### CODE — Synchronous loop execution

1. Pick next `status: pending` task with satisfied dependencies
2. Execute: w-dev → w-review → w-test → w-commit cycle
3. Task done → mark `done` → next task
4. All milestone tasks done → milestone FINISH
5. All milestones done → project FINISH

**Exception handling**:
- Design flaw → back to PLAN, update state
- Simple bug → enter DEBUG → fix → back to CODE
- Needs human intervention → create Issue in `.claude/issues/`, continue others
- Bad task split → dynamically merge/split/add tasks, update state
- Technical blockage → mark blocked, log reason, continue others

**Testing strategy**: Default to test case docs only (no test code). Add test code only when: (a) logic too complex to verify from docs alone, or (b) frequent regression making token cost unsustainable.

### REVIEW

1. Review all changes from current task
2. Focus on quality-standards dimensions: correctness, security, performance, maintainability
3. Results written to `temp/review-<req-id>.md`
4. Critical issues → back to CODE; clean → enter TEST

### TEST

1. Run `pnpm test` for existing tests
2. Run `pnpm typecheck`
3. Verify against `docs/<module>/<req-id>.test.md`
4. Results to `temp/test-<req-id>.md`
5. All pass → COMMIT; code bug → back to CODE/DEBUG; stale docs → auto w-doc → re-test

### COMMIT

1. Analyze changes, generate Conventional Commits message
2. Multiple commits allowed per task
3. No Co-Authored-By signature
4. Update `<req-id>.log.md` with commit info
5. Pause for confirmation (unless `--auto` mode)

### FINISH — Milestone wrap-up

1. Quality check: lint + typecheck + debug leftovers
2. Performance analysis: current milestone changes only
3. Doc sync: check and update related docs
4. Issue scan: summarize pending Issues in `.claude/issues/`
5. Milestone summary output
6. Update state: mark milestone done
7. Next milestone → back to PLAN; all done → end; issues found → back to CODE

## Issue Escalation

When human intervention is required:

**AI creates Issue** in `.claude/issues/ISSUE-<N>-<short-desc>.md` containing:
1. Problem description (symptoms, trigger conditions, impact)
2. Current context (phase, task, related files, attempted steps)
3. Solution A (recommended) — description + impact + risk
4. Solution B — description + impact + risk
5. User solution slot — blank for user to fill

**AI polls** on every state transition: scan `.claude/issues/`, check for decided-but-unexecuted Issues, summary of pending Issues.

## Autonomous Decision Permissions

**No-ask actions** (execute directly):
- Code style / naming → per ESLint/Prettier and code-standards
- File organization → follow existing project structure
- Dependency choice → prefer reuse
- Type annotations → strict TS, no `any`
- Error handling → explicit, no silent errors
- Stale doc updates → auto w-doc
- Review pass → auto advance to test
- Test pass → auto advance to commit
- Issue check → every state transition
- State file write → every state transition

**Must-pause actions** (unless `--auto` mode):
- After PLAN Q&A / after PLAN outputs
- DESIGN style selection / after each UI page
- New third-party dependencies
- Breaking API changes
- Before each task COMMIT
- Ambiguous trade-offs (two equally valid approaches)
- After milestone FINISH

## Directory Structure

```
project/
├── .claude/
│   ├── awf-state.json          # Workflow state (persisted)
│   ├── user/                   # User personalization (not committed)
│   └── issues/                 # Issue escalation docs
├── docs/
│   ├── <feature>.md            # Project-level (PLAN output)
│   └── <module>/
│       ├── <req-id>.md         # Requirement doc
│       ├── <req-id>.test.md    # Test cases (721)
│       └── <req-id>.log.md     # Dev log
└── temp/                       # Temp files (deletable)
```
