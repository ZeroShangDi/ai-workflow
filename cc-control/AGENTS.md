# Repository instructions

## Git commit messages

- Use `type(scope): 中文摘要` for every commit, for example: `docs(plugin): 对齐通用技能索引`.
- Keep the summary concise and specific; do not use an English-only or generic commit subject.
- Stage only changes related to the requested work. Preserve unrelated working-tree changes unless the user asks to include them.

## DSH host isolation

- AWF is optional integration inside DSH: isolate AWF initialization, event callbacks, network reporting, and disposal failures so DSH's native sessions and approval flow continue normally.
- Reuse the existing DSH Web host. Never stop, restart, or replace a shared DSH host merely to recover AWF; reject duplicate bridge connections without displacing a healthy connection.
