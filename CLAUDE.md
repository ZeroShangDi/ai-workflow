# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

This is a **Claude Code workflow configuration toolkit** — not a traditional application. It defines a complete AI-assisted development methodology through custom slash commands, skills, standards, and templates. The target projects this workflow operates on are Vue 3 + TypeScript browser extensions (pnpm monorepo, Element Plus, UnoCSS).

## Development workflow state machine

The `/awf-run` command drives a full autonomous development pipeline through these states:

```
PLAN → DESIGN (if UI) → CODE (loop per task) → REVIEW → TEST → FINISH
                          ↑                      ↑
                          └── DEBUG ←────────────┘
```

- **PLAN**: Interactive Q&A → requirements doc → prototype → WBS → task list (`/w-plan`)
- **DESIGN**: Generate 3 UI styles → user picks → save to `.claude/user/style-preferences.md` → generate UI incrementally (`/w-design`)
- **CODE**: Loop through tasks sequentially (or parallel for independent tasks with `[P]` tag) (`/w-dev`)
- **DEBUG**: Systematic debugging when bugs surface (`/w-debug`)
- **REVIEW**: Code review against code-standards + quality-standards (`/w-review`)
- **TEST**: Inspect test case docs against actual code behavior (`/w-test`)
- **FINISH**: Milestone wrap-up — quality, perf, docs, summary, memory, handoff (`/w-finish`)

Any node can loop back to previous states. FINISH is a milestone marker, not project end.

## Slash commands (`.claude/commands/`)

| Command | Purpose |
|---------|---------|
| `/awf-run` | Autonomous workflow — drives the full state machine |
| `/w-plan` | Task planning: requirements → prototype → WBS → task list |
| `/w-design` | Design lifecycle: style selection, code↔Figma, new Figma files |
| `/w-tree` | Task breakdown tree with dual-view HTML visualization |
| `/w-dev` | Development execution — explore, implement, lint, verify |
| `/w-debug` | Systematic debugging via hypothesis-evidence-elimination |
| `/w-review` | Code review against dual standards (code + quality) |
| `/w-test` | Test case inspection — compare `.test.md` docs against code |
| `/w-ui` | UI restoration from Figma (requires `node-id` in URL) |
| `/w-doc` | Module or requirement-level docs (需求文档 + 测试用例 + 开发日志) |
| `/w-commit` | Smart commit with conventional commit messages |
| `/w-finish` | Milestone wrap-up: quality/perf/doc/summary/memory/handoff |

## Skills (`.claude/skills/`)

Three standards skills apply at different phases of the workflow:

- **`design-standards`** — Architecture, data modeling, state management, composable extraction. Applied during PLAN/DESIGN.
- **`code-standards`** — Function design, naming, error handling, defensive programming. Applied during CODE/DEBUG.
- **`quality-standards`** — Testing pyramid (70/20/10), code review, conventional commits, docs. Applied during REVIEW/TEST/FINISH.

These are invoked automatically by the relevant slash commands. Do not invoke them manually unless explicitly requested.

## User configuration (`.claude/user/`)

Personal preferences stored here, NOT committed to version control:
- `style-preferences.md` — UI style choices populated by `/w-design` style selection flow
- `awf-run-requirements.md` — Original requirements document for the awf-run system

## Document system

- **`docs/`** — Feature docs, test case docs (721 progressive: 70% unit / 20% integration / 10% E2E), and dev logs. Planning-phase docs are project-wide; development-phase docs are per-requirement (`docs/<module>/<req-id>.{md,test.md,log.md}`).
- **`/temp/`** — Temporary files (audit results, etc.). All files here can be deleted at any time without affecting the system.
- **`.claude/issues/`** — Issue escalation: when blocked by a human-needed decision, AI creates an issue here with 2+ solution options, then polls for user decision.

## Permissions model

`.claude/settings.json` allows read-only git operations and common dev commands (pnpm, find, grep). Git push is explicitly denied. `.claude/settings.local.json` extends with local-only permissions (e.g., `open`).
