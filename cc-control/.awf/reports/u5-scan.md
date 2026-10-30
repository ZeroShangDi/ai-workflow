# U5 粗略扫：skills/命令文本的 cc 措辞（标注，未彻底改）

> 任务：W1-054（低优先级）——只标注，不彻底改。方向：把引用「运行实现字面」（claude、spawn、tmux/CC 会话、`.claude/*` 路径等）的措辞在未来改为引用行为语义；完整去实现字面收口见 W1-083（命令/skill 描述）。

## 扫到的高信号处（示例，非全量）

| 文件 | 行 | 措辞 | 标注 |
|---|---|---|---|
| plugin/plugin-code/commands/w-plan-check.md / w-plan-wbs.md / w-plan-tasks.md | 头部 | "由 CLI …调用 `claude -p` 时使用" | cc 字面（调用实现）；未来改「规划子步骤一次性模型调用」语义 |
| plugin/core/commands/w-monitor.md | 多处 | "tmux Claude Code / 非 tmux Claude Code 会话"、"直接向 tmux CC 派发" | cc/会话实现字面；未来改「受管会话 / 主会话」语义 |
| plugin/core/commands/w-pause.md | 11 | "tmux Claude Code 不会被本命令强制中断" | 同上（受管会话） |
| plugin/core/skills/awf-run-* / awf-run-decision 等 | 头部 | "当 tmux 的 cc 运行…" | cc/会话字面（低） |
| plugin/core/skills/awf-run-error/references/issue-escalation.md | 13,23 | `.claude/issues/…` 路径 | 实现路径字面（需与目标项目 `.claude` 约定核对） |
| plugin/plugin-code/commands/w-plan.md | 169 | "tmux 托管会话 → 经 server /cmd 发 /clear" | 运行实现字面（能力描述偏实现） |
| plugin/plugin-code/skills/code-context-onboard/SKILL.md | 11 | 引用 `REMvisual/claude-handoff` 外部仓库 | 外部命名（保留即可） |
| plugin/core/commands/w-state.md | 3 | "MCP server 在 tmux session 启动时自动配置" | 会话字面（低） |

## 处置

- 本轮仅扫描并标注（见上表），不做文本改写——避免低价值 diff 干扰高优先级 W1 任务。
- 标注原则：`claude -p`/`spawn claude`/`tmux 的 cc`/`tmux 托管会话`/`.claude/…` 等「运行实现字面」在描述语义处建议改为行为语义（如「规划一次性模型调用」「受管会话」）；引用「who/what」（外部工具名、状态文件路径）类如 `.claude/issues/`、外部仓库名需结合目标项目约定确认后再动。
- 完整收口：W1-083（命令/skill 描述去实现字面）与 W3-004（外部 claude 字面）执行时按本表逐项替换；如需跳过某条标注，在表内删除即可。
