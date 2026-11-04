# Remote Agent Plugin Foundation

Read README.md and docs/template-audit.md before implementation. This project must remain runnable without its original template directory.

- Research reusable SDKs/templates before implementing each module; prefer small dependencies and thin adapters.
- Keep the first version functional and small. Do not add speculative frameworks or microservices.
- Source folders are at most four levels deep. Colocate related resources.
- Shared contracts are in foundation/contracts; business contracts belong to their src/server feature. Import other modules only through their public index.ts.
- Functions require JSDoc, stay below 100 lines; files stay below 500 lines unless cohesion justifies an explicit exception.
- Prefer pure functions, guard clauses, composition, explicit dependencies and isolated side effects.
- Explain complex logic with single-line comments. Format all source with Prettier.
- Test stable behavior, authorization, invalid input, cancellation and failure paths relevant to each change.
- Do not expose credentials through tools, logs or Skill instructions. Only trusted clients handle credentials.
- Run npm run check before delivery. Do not claim untested host integrations work.

- Put product rules, schemas, queries and API routes in src/server; tools in src/mcp; pages in src/web.
- foundation never imports src. Product configuration is injected through the composition root.
- Maintain Skills only in skills/. Host packages under artifacts/ are generated and must not be hand-edited.
- Root files required by Node, TypeScript, Docker and host package standards must retain their required locations.
