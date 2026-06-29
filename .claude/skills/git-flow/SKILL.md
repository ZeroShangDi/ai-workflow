---
name: git-flow
description: >
  Git Flow branching model for the workflow system. Defines branch naming conventions, feature/release/hotfix
  workflows, and merge rules. Referenced by w-commit for branch management. Trigger when the user asks about
  "branching strategy", "git flow", "feature branch", "release branch", or "hotfix".
---

# Git Flow — Branch Management Model

This skill defines the Git Flow branching model used as the default branch strategy. Commands (w-commit) reference this skill for branch operations.

## Branch Architecture

```
main        ●───●─────────●─────────●───  (production releases)
            │             │         │
develop     ●───●───●─────●───●─────●───  (integration)
                  │         │
feature/*   ●─────●         │            (feature development)
                            │
release/*         ●─────────●            (release preparation)
                              │
hotfix/*                     ●───────────  (emergency fixes)
```

## Branch Types

| Branch | Purpose | Naming | Lifetime |
|--------|---------|--------|----------|
| `main` | Production-ready code. Every commit = a release. | Fixed | Forever |
| `develop` | Integration branch. Feature branches merge here. | Fixed | Forever |
| `feature/*` | New features. Branched from `develop`, merged back to `develop`. | `feature/<kebab-case>` | Deleted after merge |
| `release/*` | Release preparation. Branched from `develop`, merged to `main` AND `develop`. | `release/v<version>` | Deleted after merge |
| `hotfix/*` | Emergency production fixes. Branched from `main`, merged to `main` AND `develop`. | `hotfix/<kebab-case>` | Deleted after merge |

## Feature Branch Workflow

Called by w-commit when a task represents a new feature:

1. **Create**: `git checkout -b feature/<name> develop` (or from current branch if `develop` doesn't exist)
2. **Work**: commit freely on the feature branch
3. **Finish**: `git checkout develop && git merge --no-ff feature/<name>` — always use `--no-ff` to preserve branch history
4. **Clean up**: `git branch -d feature/<name>`

If the project doesn't have `develop` yet, create it from `main`: `git checkout -b develop main`.

## Release Branch Workflow

Called when a milestone is complete and ready for release:

1. **Create**: `git checkout -b release/v<version> develop`
2. **Stabilize**: bump version, final fixes, update changelog — no new features
3. **Finish**:
   - `git checkout main && git merge --no-ff release/v<version>`
   - `git tag -a v<version> -m "Release v<version>"`
   - `git checkout develop && git merge --no-ff release/v<version>`
4. **Clean up**: `git branch -d release/v<version>`

## Hotfix Workflow

Called when an urgent production fix is needed:

1. **Create**: `git checkout -b hotfix/<name> main`
2. **Fix**: commit the fix (bump PATCH version)
3. **Finish**:
   - `git checkout main && git merge --no-ff hotfix/<name>`
   - `git tag -a v<version> -m "Hotfix v<version>"`
   - `git checkout develop && git merge --no-ff hotfix/<name>`
4. **Clean up**: `git branch -d hotfix/<name>`

## Branch Naming Rules

- Use kebab-case: `feature/user-auth`, `hotfix/login-crash`
- Keep names short and descriptive
- No spaces, no special characters except `-` and `/`
- Version branches: `release/v1.2.0`, `release/v2.0.0-rc.1`

## Simplified Mode (Small Projects)

For small projects or solo development, a simplified flow can be used:

- Skip `develop` — branch `feature/*` from `main`, merge back to `main`
- Skip `release/*` — tag directly on `main` after merge
- Keep `hotfix/*` for emergencies

The decision to use full vs simplified Git Flow is determined by project needs (team size > 1 recommends full flow).

## Future: User Configuration

When user settings are implemented:
- `gitFlow.mode`: `full` / `simplified` (default) — which flow variant to use
- `gitFlow.autoFeatureBranch`: `true` (default) / `false` — auto-create feature branch per task
- `gitFlow.deleteAfterMerge`: `true` (default) / `false` — auto-delete branches after merge
