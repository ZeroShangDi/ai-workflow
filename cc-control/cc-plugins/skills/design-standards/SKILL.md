---
name: design-standards
description: >
  Macro-level architecture and design standards for structuring systems, modules, and data models.
  Use when planning features (w-plan), breaking down tasks (w-tree), designing architecture,
  modeling data, or setting up state management (Pinia stores). Trigger when the user asks about
  "architecture", "design pattern", "how to structure", "refactoring a module", "component design",
  "data modeling", "state management", "store design", composable extraction, or module boundaries.
  This is about making the system as a whole maintainable, not about individual lines of code.
---

# Design Standards — Architecting Systems Well

These principles apply when stepping back from individual lines of code to think about structure — how modules, components, stores, and data fit together. They keep complexity manageable as the system grows.

## Architecture

### Composition over inheritance

Inheritance creates rigid hierarchies — change the parent, and every descendant must adapt. Composition lets you assemble behavior from independent, replaceable pieces.

In Vue 3: prefer `useXxx()` composables over base component classes. Prefer slots over component extension. Reserve inheritance for genuine "is-a" relationships, and keep the hierarchy to 2 levels or fewer.

### Rule of Three

- First occurrence: write it directly
- Second occurrence: copy it, mentally note the duplication
- Third occurrence: *now* extract the shared abstraction

Premature abstraction is worse than duplication. Abstracting too early locks in the wrong shape — you don't yet know what truly varies. By the third case, the pattern is clear.

### Unidirectional data flow

Data flows one way: `User action → State update → View re-render`. Child components notify parents via events; they never mutate props directly. This makes data flow predictable — when something breaks, you trace backward along a single path.

### Separate side effects from pure logic

Components should render UI and delegate to services. Business logic, API calls, caching, and persistence belong in dedicated layers — composables, store actions, or service modules. The component stays focused on presentation; the logic becomes independently testable and swappable.

### Interface segregation

A module shouldn't depend on anything it doesn't use. Component props should include only what the component actually needs — not a whole user object when it only renders a name. Narrow interfaces mean a narrow blast radius when requirements change.

### Law of Demeter (Principle of Least Knowledge)

Objects should only communicate with their immediate neighbors. Chained access like `user.profile.address.city` couples the caller to the entire object graph — change any link, and the caller breaks. Encapsulate traversal behind a method: `user.getCity()` hides the internal structure and absorbs change.

### Explicit over implicit

Dependencies should be visible (passed as parameters, not pulled from globals). Logic should be readable (no clever tricks that require three passes to understand). Data flow should be traceable (no shared state mutated from deep in the call stack). When something breaks, you should be able to follow the trail.

### Locality of behavior

Related code lives together. A private helper sits right below its caller. A feature's files live in the same directory. The measure of good organization: fixing a bug or adding a feature touches as few files as possible.

### Design by contract

Every function documents its terms of engagement:
- **Precondition**: what must be true before calling (validate at call site)
- **Postcondition**: what is guaranteed after returning (the function's promise to callers)
- **Invariant**: what remains true throughout execution

TypeScript types are the first line of contract enforcement — use them to express constraints, not just shapes.

### Configuration separate from code

Values that might change without a code change — URLs, thresholds, feature flags, timeouts — belong in configuration, not hard-coded. If you find yourself thinking "we might need to tweak this later," extract it now.

## Data Modeling

### Single source of truth

Each piece of data has exactly one authoritative home. Every other location references or derives from it — never keeps its own copy. When data exists in two places, one will eventually be wrong.

### Derived state is not stored

If you can compute it from existing state, don't store it. `fullName` derives from `firstName + lastName`; storing it separately means every name update must also update `fullName` — and one day, one path will be missed. In Vue, use `computed`. In Pinia, use getters.

### Immutability first

Shared state should be replaced, not mutated in place. Create a new version on update. Benefits: every change is traceable, undo/redo is trivial (restore the previous reference), and concurrent operations don't corrupt each other.

### State machines over boolean flags

Instead of `isLoading`, `hasError`, `isEmpty` as independent booleans, model explicit states: `idle | loading | success | error | empty`. This eliminates impossible combinations (loading AND error?) and makes every transition explicit and intentional.

### Normalize nested data

Deep nesting makes updates complex and lookups slow. Use a flat, relational structure:

```typescript
// Nested — hard to update a single post
{ users: [{ id: 1, posts: [{ id: 10, title: "..." }] }] }

// Normalized — O(1) lookup, single-point updates
{
  users: { byId: { 1: { id: 1, postIds: [10] } }, allIds: [1] },
  posts: { byId: { 10: { id: 10, title: "..." } }, allIds: [10] }
}
```

### Avoid oversized state objects

A single state object with 10+ unrelated fields is hard to reason about and causes unnecessary re-renders. Split by domain — a chat store shouldn't own UI preferences, and vice versa.

### Domain models ≠ DTOs

- **Domain models**: carry business rules and behavior, live inside the application
- **DTOs (Data Transfer Objects)**: pure data carriers for API communication

Keep them separate. Transform at the API boundary. Don't let wire format decisions pollute your business logic.

### Optimistic updates with rollback

For high-frequency interactions, update the UI immediately (optimistically), then confirm with the server. If the request fails, roll back to the previous state. The rollback must be complete and tested — partial rollback is worse than waiting for the server.

### Stable identifiers

A record's unique identifier should be assigned once and never change. Use business ids or UUIDs — never array indices or temporary keys. Changing an id breaks every reference, cache, and relationship pointing to that record.

### Version data that persists

Any data stored across sessions (localStorage, IndexedDB) should carry a version number. On read, run migrations to transform old formats to current. Without this, a data format change breaks every existing user's stored state.

## Design Patterns

### Strategy pattern over if-else chains

When behavior varies by type, use a lookup map instead of cascading conditions:

```typescript
// Avoid
if (type === 'A')
  handleA()
else if (type === 'B')
  handleB()

// Prefer — new types don't touch existing code
const handlers: Record<string, () => void> = { A: handleA, B: handleB }
handlers[type]?.()
```

### Adapter pattern for external dependencies

Wrap third-party APIs in your own interface. When the library changes or you swap providers, only the adapter changes — the rest of the codebase is untouched. This is high-value for payment, storage, and analytics integrations.

### Observer pattern for decoupled events

A publisher emits events without knowing who listens; subscribers react without knowing who emits. In Vue, this means `watch`/`watchEffect` and event buses. Use it when multiple independent components need to react to the same state change.

### Factory pattern for complex object creation

When constructing an object requires multiple steps, dependencies, or decisions, encapsulate that complexity in a factory function. Callers get a ready-to-use object without knowing how it was built.

### Decorator pattern for cross-cutting concerns

Add behavior (logging, timing, caching, permission checks) without modifying the original function. Higher-order functions and Vue's `onServerPrefetch`/`watch` are decorator-like in spirit.

## Vue 3 + Pinia Specifics

### Lift state only as high as necessary

State shared by multiple components goes to the nearest common ancestor (provide/inject or Pinia store). State used by one component stays in that component. Lower is better; higher requires more justification.

### Split stores by domain

A store should own one domain — chat messages, user preferences, file uploads are separate stores. Don't create a monolithic "app store." This keeps actions focused and reduces re-render scope.

### Actions encapsulate mutations

Components call actions; actions update state. Never mutate store state directly from a component. This single entry point enables validation, side effects, and logging without touching component code.

### Opt out of deep reactivity for large data

When a store holds large, infrequently-mutated data structures, use `shallowRef` or `markRaw` to avoid the cost of deep reactivity. Mutate by replacing the whole object, not by drilling into nested fields.
