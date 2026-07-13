---
name: code-standards
description: >
  Micro-level coding standards for writing clean, correct code — function design, naming, error handling,
  defensive programming, and code style. Use whenever writing or modifying any code, especially during
  development (w-dev) and debugging (w-debug). Also trigger when the user asks about "how to write this",
  "best practices", "clean code", naming, refactoring a function, error handling, or code organization
  within a single file. This is about making each line, function, and file correct and readable.
---

# Code Standards — Writing Code Well

These principles apply at the function, variable, and file level — the decisions you make line by line as you write code. They exist to make code easy to understand and safe to modify.

## Function Design

### One function, one thing

If you need "and" or "or" to describe what a function does, split it. A function should do one thing completely enough that a single short sentence describes it.

### Keep functions short

Target 20 lines or fewer. Long functions are hard to test and hard to reason about — the reader must keep too much in their head. When a function grows, extract private helpers. The caller stays readable; the extracted pieces become independently testable.

### Limit parameters

Pure functions should take at most 3 arguments. Beyond that, group parameters into an options object. This prevents call-site confusion (which argument is which?) and makes future extensions non-breaking.

### Pure functions first

A pure function — same input always yields same output, no side effects — is trivially testable and easy to reason about. Push side effects (API calls, file I/O, DOM writes) to the edges: event handlers, service layers, or store actions. The core logic stays pure.

### Consistent return types

A function shouldn't return an object in one branch, null in another, and throw in a third. Choose one pattern for "no result" (null, undefined, Result type, or throw) and use it consistently across the module.

### Name by intent, not implementation

Callers care about *what*, not *how*. `saveUser()` stays correct even if you swap the database; `insertIntoDatabase()` becomes a lie. If you change the implementation, the name should still make sense.

## Naming

### Names are documentation

A well-named variable eliminates the need for a comment. If you need a comment to explain what something holds, rename it.

- Functions: verb + business noun — `getUserInfo`, `validateEmail`, `computeDiscount`
- Booleans: `is` / `has` / `can` prefix — `isActive`, `hasPermission`, `canEdit`
- Event handlers: `handle` + action + target — `handleSendClick`, `handleFileDrop`

### Expressive variables over complex expressions

Extract conditions into named variables so the intent is obvious at a glance:

```typescript
// Reads like a puzzle
if (user.status === 'active' && user.role === 'admin' && !user.suspended)

// Reads like English
const isActiveAdmin = user.status === 'active' && user.role === 'admin' && !user.suspended
if (isActiveAdmin)
```

### Constants for magic numbers

Any literal other than 0 or 1 deserves a name. `const TAX_RATE = 0.13` is self-documenting; `price * 0.13` makes the reader guess.

### Enums over magic strings

`Status.Active` gets IDE autocompletion, renaming safety, and catches typos at compile time. `'active'` gets runtime bugs from a misspelled `'actvie'`.

## Error Handling

### Be explicit, not silent

Errors must be caught and handled. Swallowing errors silently turns a detectable failure into a mystery bug downstream. Error messages should carry enough context to locate the problem without a debugger.

### Categorize errors by type

- **Systemic** (network down, auth expired, 5xx) → global handler (toast, retry, log)
- **Business** (invalid input, duplicate record, 4xx) → local handler near the call site

This avoids scattering retry logic everywhere while keeping business rule violations close to the relevant UI.

### Trust boundaries

Validate data that crosses system boundaries (user input, API responses, third-party data). Trust data that stays within your own code. Don't re-validate the same thing in every internal function — it creates noise and a false sense of security.

## Defensive Programming

### Avoid null hell

Don't write `if (data && data.user && data.user.name)`. Use optional chaining (`data?.user?.name`) and nullish coalescing (`data?.user?.name ?? 'Unknown'`). Better yet, design data structures that don't need null checks — use empty objects or sensible defaults at the boundary.

### Validate at the boundary, once

Parse and validate data when it enters your system. After that, internal code can assume the data is valid. Spreading validation across every function creates maintenance burden and inconsistent error messages.

## Code Style

### Positive conditionals

Write `if (isValid)` not `if (!isInvalid)`. Double negatives force the reader to mentally invert twice. Positive forms are processed faster and misunderstood less often.

### Comments explain why, not what

The code shows what it does. Comments explain non-obvious reasons: a workaround for a library bug, a surprising performance tradeoff, a regulatory constraint. If the "what" isn't obvious, improve the naming, don't add a comment.

### Blank lines create visual structure

Group related lines together; separate logical blocks with blank lines. A reader scanning the file should grasp its structure without reading every line.

### Organize imports by origin

With blank lines between groups: third-party packages → internal modules (`~/`) → relative imports → styles. This lets readers instantly see external dependencies.

### Keep files balanced

Aim for 100–300 lines. Below 100 feels fragmented; above 500 signals it's time to split. Files that are too large hide structure; files that are too small create navigation overhead.

## Performance Awareness

### Memoization for expensive pure functions

When a pure function is called frequently with the same arguments and the computation is non-trivial, cache the result. In Vue, this is `computed`; in plain TS, use a `Map` with a size limit.

### Lazy evaluation

Don't compute values until they're actually needed. Vue's `computed` is lazy by default. For expensive initializations, use a lazy getter pattern rather than computing at module load time.

### Throttle and debounce

- **Debounce**: wait until the user stops before acting (search-as-you-type)
- **Throttle**: act at most once per interval (scroll handlers, resize listeners)

Choosing the wrong one causes either sluggish UI (throttle on search) or wasted work (debounce on scroll).

### Batch state updates

Multiple state changes in the same synchronous block should trigger one re-render, not many. Vue batches by default within a tick. Avoid interleaving state mutations with `await` unnecessarily — each `await` creates a new microtask boundary.

### Deep vs shallow copy

Use shallow copy (spread) for immutable updates — it's fast and structure-sharing saves memory. Use deep copy only when you genuinely need complete isolation. For complex nested updates, use a library like Immer rather than hand-rolling deep clones.

## Vue 3 Specifics

### Group by concern in `<script setup>`

Keep all code for one feature — state, computed, methods, lifecycle — together in a block. Don't scatter related logic across the file. When a concern grows past ~50 lines, extract it into a `useXxx` composable.

### Side effects in `watch`/`watchEffect`, not in `computed`

Computed properties should be pure derivations. Never trigger API calls, mutations, or DOM writes inside a computed — it breaks predictability and causes infinite update loops.

### `shallowRef` for large replaced objects

When you replace the whole object rather than mutating nested fields, `shallowRef` avoids the cost of deep reactivity tracking. The same applies to large lists that are fully replaced on update.

### Stable keys for lists

Always use a stable, unique identifier as `:key` in `v-for` — a business id or uuid, never array index. Index-based keys cause DOM recycling bugs when the list reorders.
