---
name: quality-standards
description: >
  Quality assurance and delivery standards — testing, code review, commits, documentation, and
  technical debt management. Use when reviewing code (w-review), verifying tests (w-test),
  committing (w-commit), wrapping up development (w-finish), or writing documentation (w-doc).
  Trigger when the user asks about "testing strategy", "how to test", "code review", "commit
  message", "technical debt", "documentation", "release checklist", or "is this ready to ship".
  This is about verifying correctness and delivering with confidence.
---

# Quality Standards — Delivering With Confidence

These principles cover how to verify correctness, communicate change, and keep the codebase healthy over time. Apply them when moving work from "done" to "shipped."

## Testing

### The testing pyramid

Allocate testing effort for maximum confidence per unit of effort:

- **Unit tests (~70%)**: Fast, isolated, run on every change. Test pure logic — functions, composables, store actions. These catch regressions immediately.
- **Integration tests (~20%)**: Verify modules work together. Test store interactions, API calls against mocked endpoints, multi-component workflows.
- **End-to-end tests (~10%)**: Verify critical user journeys. Keep these few and focused — they're slow, brittle, and expensive to maintain.

### Test behavior, not implementation

Tests should verify *what* the code accomplishes, not *how* it does it internally. If a refactoring passes existing tests without modification, the tests are well-designed. If renaming a private function breaks 10 tests, the tests are coupled to implementation details — they're testing the wrong thing.

### Test naming: scenario → expected outcome

Name tests so a failure immediately communicates what went wrong: `"when user is inactive, login returns UNAUTHORIZED"`. The reader understands the setup, action, and expectation without opening the test body.

### TDD when the logic is well-defined

For parsers, validators, calculations, and state transitions:
1. Write a failing test that expresses the desired behavior
2. Write the minimum code to make it pass
3. Refactor with the test as your safety net

TDD produces naturally testable code — the test is the first consumer of the interface. Skip it for exploratory work, UI polish, or ill-defined requirements.

### Test coverage philosophy

Coverage percentage is a signal, not a target. Focus on covering *behaviors*: happy path, edge cases (null, empty, boundary values), error paths (network failure, invalid input), and state transitions. A 100% coverage metric with no edge case tests is worse than 70% coverage that tests all the dangerous paths.

## Code Review

### Review what tools can't catch

Tools handle formatting (Prettier), syntax (TypeScript), and lint rules (ESLint). Human review focuses on:
- **Correctness**: Are edge cases handled? Do error paths work?
- **Intent**: Is the purpose clear from reading the code?
- **Architecture**: Does this mesh with surrounding code or fight existing patterns?
- **Security**: XSS, injection, data exposure — especially critical in browser extensions

### Every line is reviewed

No change is "too simple to review." Seemingly trivial changes can interact with extension contexts (content script ↔ background ↔ sidepanel) in surprising ways.

### Review with the right mindset

The goal is not to find something to criticize — it's to ensure the change is correct, understandable, and maintainable. If nothing is wrong, that's a successful review.

## Commits

### Conventional Commits

```
<type>: <short Chinese description>

[Optional body explaining why, not what]
```

Types: `feat` (new capability), `fix` (bug fix), `refactor` (restructure without behavior change), `style` (formatting), `docs`, `chore`, `perf`

### Small, single-concern commits

Each commit addresses exactly one thing. Small commits are easy to review (reviewer can hold the entire change in their head), easy to revert (no collateral damage), and easy to understand months later in git blame.

### Commit messages explain motivation

The diff shows *what*. The message explains *why* — the problem, the constraint, the tradeoff. A reader of the git log should understand the project's evolution without opening a single file.

### If the pre-commit hook fails

Fix the issue, then create a new commit. Don't amend — the previous commit never completed, so there's nothing to amend. Amending published commits rewrites shared history; don't do it.

## Technical Debt

### Make it visible

Temporary solutions need a label: `// TODO(username): <what needs to change> <date>`. An unowned, undated `// TODO` is invisible to everyone, including the author six months later.

### Schedule the fix

Debt that isn't on the backlog never gets addressed. When you take a shortcut, create a task. Debt is manageable when tracked; it's dangerous when it accumulates silently in the code.

### Semantic versioning awareness

When changing shared code (packages, APIs, exported types):
- New backward-compatible capability → minor version
- Breaking change → major version
- Bug fix → patch version

Think about consumers before you break them.

## Documentation

### Code documents itself first

Clear names, small functions, and explicit data flow are the primary documentation. Only when the *interactions* between pieces aren't obvious from reading each piece individually do you need separate docs.

### Write docs for complex interactions

A `docs/<module>.md` is warranted when understanding the module requires tracking data across multiple files, contexts, or async boundaries — multi-step flows, cross-context messaging in browser extensions, state machines with many transitions.

### Docs live with code

Documentation is in the same repo as the code, updated in the same commit as the change. Outdated docs are actively harmful — they mislead the reader into thinking they understand a system that has since changed.

## Observability

### Log with intent

- `error`: needs human attention now
- `warn`: unexpected but handled — worth investigating later
- `info`: key lifecycle events (session start, feature toggle, auth state change)
- `debug`: detailed state, only for local development

Every log line should answer a question someone will actually need to ask when diagnosing a problem. Logging for its own sake creates noise that buries the signal.

### Performance has a baseline

Critical paths (message rendering, SSE processing, API calls) should have a known performance profile. When you change code on a critical path, consider: will this add re-renders? Block the main thread? Accumulate memory over time?

### Error monitoring in production

Production errors should be reported automatically — don't wait for user complaints. Critical errors (auth failures, data loss, payment issues) should trigger alerts. If you don't know it's broken, you can't fix it.
