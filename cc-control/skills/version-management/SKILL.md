---
name: version-management
description: >
  Semantic versioning methodology for the workflow system. Defines when and how to bump version
  numbers, tag naming conventions, and auto-determination rules from conventional commits.
  Referenced by w-commit during the version/tag step. Trigger when the user asks about "versioning",
  "semver", "tagging", "bump version", or "release management".
---

# Version Management — Semantic Versioning and Tagging

This skill defines the methodology for version management. Commands (w-commit) reference this skill; they do not inline versioning rules.

## Semver Core Rules

Given `MAJOR.MINOR.PATCH` (e.g., `1.4.2`):

| Bump | When | Example |
|------|------|---------|
| **MAJOR** | Breaking changes — API removed, behavior changed in incompatible ways | `1.4.2` → `2.0.0` |
| **MINOR** | New functionality added, backward-compatible | `1.4.2` → `1.5.0` |
| **PATCH** | Bug fixes, performance improvements, refactoring (no API change) | `1.4.2` → `1.4.3` |

Pre-1.0.0 versions (0.x.y): treat MINOR as potentially breaking. Bump MINOR freely, PATCH for fixes.

## Auto-Determination from Conventional Commits

When `--bump` is used without explicit level, derive from commit messages since last tag:

| Commit Type | Semver Bump |
|-------------|-------------|
| `feat:` | **MINOR** |
| `fix:`, `perf:` | **PATCH** |
| `refactor:`, `docs:`, `style:`, `chore:`, `test:` | **PATCH** (default) |
| Any commit with `BREAKING CHANGE:` in body | **MAJOR** (overrides all) |

If no conventional commits found since last tag → default to PATCH.

## Tag Convention

```
v<MAJOR>.<MINOR>.<PATCH>
```

Examples: `v1.0.0`, `v2.3.1`, `v0.1.0`

Tags are **annotated** (`git tag -a`) with a message summarizing the changes since the last tag.

## Pre-Release Versions

For unstable releases, append a pre-release identifier:

```
v1.0.0-alpha.1
v1.0.0-beta.2
v1.0.0-rc.1
```

Pre-release sequence: `alpha` → `beta` → `rc` → final release.

## Execution Steps (Called by w-commit)

1. Read current version from `package.json` (or `pyproject.toml`, `Cargo.toml` — auto-detect)
2. Determine bump level: explicit `--bump <level>` > auto-detect from commits > default to `patch`
3. Execute `npm version <level>` (or equivalent for detected package manager):
   - Bumps the version field in the package file
   - Creates a `git tag -a v<new-version>` with changelog summary
   - Commits the version bump (message: `chore: bump version to v<new-version>`)
4. Output summary: `Version bumped: 1.4.2 → 1.5.0 (minor) — tag v1.5.0 created`

## No-Bump Scenarios

Skip version bump when:
- The current change is purely `docs:`, `style:`, or `chore:` with no user-facing impact
- No commits since last tag (nothing to release)
- `--no-bump` flag is explicitly set

## Future: User Configuration

When user settings are implemented, the following will be configurable:
- `version.autoBump`: `true` (default) / `false` — whether to auto-bump on commit
- `version.tagPrefix`: `v` (default) — tag prefix, e.g., `v` or `release-`
- `version.preRelease`: `false` (default) / `alpha` / `beta` / `rc` — pre-release mode
