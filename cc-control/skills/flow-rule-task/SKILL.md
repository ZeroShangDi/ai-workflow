---
name: flow-rule-task
description: >
  Task decomposition rules — how to break work into tasks at the right granularity.
  Triggered during PLAN phase when creating WBS and task lists.
  Used by /w-plan and /w-tree commands.
---

# Task Granularity — How to Split Work

## Core Principle

**Don't split without understanding the implementation.** The quality of decomposition depends on knowing the implementation approach, steps, and effort. Split before understanding → wrong boundaries.

> 所有的拆分都需要先考虑好实现方案，实现步骤，每个步骤的工作量才好想怎么拆分。

## Task Hierarchy (Top-Down Positioning)

```
Ecosystem → System → Milestone → Project → Module/Requirement → Feature → Task → (Action) → (Atomic)
                                                                         ↑
                                                                  minimum unit
```

| Level | Scope | Example |
|-------|-------|---------|
| Ecosystem | Multi-product business landscape | WeChat ecosystem (Mini Program + Official Account + Pay + Store) |
| System | Multiple projects serving one goal | Backend API + User App + Admin Dashboard |
| Milestone | Versioned iterations | v0.1 MVP → v0.2 → v1.0 |
| Project | A complete deployable unit | Frontend app, Backend service, CLI plugin |
| Module/Requirement | A self-contained subsystem | Auth module, Payment module |
| Feature | A user-facing capability | Dark mode, Export PDF, Search filter |
| **Task** | **Claude Code one-shot solvable** | Implement StateParser, Add cache interceptor |
| Action | 3-8 atomic ops, not used as a task | Rename a function, Add a config field |
| Atomic | Single function/line/command, almost never used | One `const` declaration |

**Task is the minimum unit used in practice.** Action and Atomic levels exist conceptually but should not appear in WBS or task lists.

## Task Definition

A task is the granularity that **Claude Code can solve in one session**. Anchor: 1-5 files, 50-300 lines changed, with a clear independently verifiable completion condition.

**The task is a flexible container** — simple features can be one task, complex requirements can be one task. Granularity follows actual complexity, not a formula.

## The Universal Pattern

Every decomposition follows this 5-phase structure:

```
Understand → Design → Implement → Assemble → Verify
```

Not every phase needs sub-tasks. Split a phase only when it's complex enough to warrant it.

### Phase breakdown

| Phase | Purpose | When to split into sub-tasks |
|-------|---------|------------------------------|
| **Understand** | Explore unknowns, scope the problem | Multiple independent unknowns to investigate |
| **Design** | Define rules, interfaces, conventions | Cross-module coupling needs upfront alignment |
| **Implement** | Build the thing | Core complexity lives here — split by independence |
| **Assemble** | Wire modules together, integration | Always at least one assembly task |
| **Verify** | End-to-end validation, regression, post-mortem | Always at least one verification task |

## Splitting Rules

### When to split

| Signal | Action |
|--------|--------|
| **Independently verifiable** | Split — if A can be confirmed correct without B, they're separate tasks |
| **High complexity** | Split — extract the complex part into its own task |
| **Independent data source** | Split — different inputs, different validation |
| **Cross-cutting rules needed** | Split — when modules couple, extract a "define conventions" task first |
| **Dependency chain exists** | Split and sequence — order by dependency |

### When NOT to split

| Signal | Action |
|--------|--------|
| **Homogeneous logic** | Merge — same pattern, same code, same task |
| **Thin layer / glue code** | Merge — routing, assembly, pass-through logic |
| **Don't know enough yet** | Don't split — explore first, then decide |
| **No reason to split** | Don't — splitting is a tool, not a goal |
| **Coupled validation** | Merge — if correctness can only be verified together, keep together |

## Core Decision Standards

**Primary standard — Independently Verifiable:**
> Can I confirm A is correct without B being done? Yes → split. No → merge.

**Secondary standard — Top-Down Positioning:**
> Start from the appropriate hierarchy level, drill down only where complexity demands it. Don't pre-split all levels upfront.

**Tertiary standard — Progressive Splitting:**
> Split by functionality first, drill deeper during implementation when complexity reveals itself.

## Context Modifiers

Different contexts modify the base pattern:

| Context | Strategy |
|---------|----------|
| **Uncertain** | Explore first. Don't wait for full understanding — one explore task, then split based on findings |
| **Emergency** | Stop-bleeding first, root-cause later. Parallel investigation, fast convergence |
| **Has foundation** | Incrementally add on existing framework. Split by added feature |
| **No foundation** | Build each part independently first, find commonality, then refactor. Or: design conventions first, then build |
| **Pure research** | Know yourself → Know options → Compare dimensions → Synthesize. Split by dimension |
| **Migration** | Explore → Tooling → Independent tables first → Dependent tables → Verify correctness → Full regression |

## Non-Implementation Tasks

These are first-class tasks, not afterthoughts:

- **Explore/Research**: Reduce uncertainty before design
- **Design/Conventions**: Define rules when modules couple
- **Tooling/Scripts**: Build helpers for the main work
- **Assemble/Integrate**: Wire independently-built modules
- **Test/Verify/Regression**: Confirm correctness
- **Debug/Troubleshoot**: Diagnose and fix issues
- **Operational**: Breakpoint recovery, data validation, rollback plans
- **Post-mortem/Review**: Learn from incidents
- **Non-functional**: Packaging, preview, documentation

## Progressive Splitting

Splitting is not a one-time upfront activity:

1. Position the work in the hierarchy (which level?)
2. Split at the current level by functionality
3. For each functional chunk: complex? → drill down. Not complex? → stop.
4. During implementation: discover complexity? → split further. No complexity? → continue.
5. Always end with an assembly + verification task

## Examples

### Feature dev (has foundation): Add Redis cache to REST API

```
1. [Explore] Understand existing middleware, cache points
2. [Implement] MVP: TTL cache read/write → verify feasibility
3. [Implement] Interceptor integration
4. [Implement] Cache invalidation strategy
5. [Assemble] Full integration + regression test
```

### Feature dev (no foundation): Cross-platform Button (React/Vue/Web Component)

```
1. [Design] Define cross-platform interface spec (props, events, slots)
2. [Design] Theme token definitions, style configuration
3. [Implement] Common style engine
4. [Implement] React implementation
5. [Implement] Vue implementation
6. [Implement] Web Component implementation
7. [Implement] Size variants, loading states
8. [Assemble] Build pipeline + preview
```

Fallback if commonality is unclear:
```
1. [Implement] React Button independently
2. [Implement] Vue Button independently
3. [Implement] Web Component independently
4. [Refactor] Extract shared logic
5. [Assemble] Unify build + preview
```

### Emergency: Payment callback rate drop

```
1. [Stop bleeding] Parallel: check recent deploys, third-party status, DB metrics
2. [Respond] If code → rollback. If third-party → contact + fallback. If neither → announce + reassure.
3. [Root cause] Deep investigation
4. [Fix] Implement solution
5. [Post-mortem] Retrospective document
```

### Pure research: React vs Vue selection

```
1. [Understand self] Team skills, existing assets, hiring difficulty, project requirements
2. [Analyze project] What features, what constraints
3. [Compare frameworks] Feature matrix, differences
4. [Evaluate ecosystem] Plugin/library availability, project fit
5. [Estimate long-term] Evolution cost, maintenance burden
6. [Synthesize] Comprehensive recommendation — not best, but most suitable with lowest risk
```

## Interaction with WBS

WBS items are **deliverables**, tasks are **executable work units**. One WBS item may contain multiple tasks if complex; one task may cover multiple WBS items if simple.

Mapping example:
```
WBS: "Data collection module"  →  Tasks: StateParser, GitExtractor, FileExtractor
WBS: "Config module"           →  Tasks: config (simple, 1:1)
```
