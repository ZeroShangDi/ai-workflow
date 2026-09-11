# awf plan — 功能文档

> 对应 WBS：
> 源码：`src/cli/plan.js`（入口 `planCommand`）→ `src/lib/plugin-bridge.js`（`planEntry`）→ `src/adapters/interactive.cjs`（`launchInteractiveClaude`）

## 功能描述

`awf plan` 以交互式 Claude Code 会话承载需求规划：CLI 不做任何规划逻辑，只负责

1. 判定是否要归档残留旧 state（避免新规划叠加到旧任务上）；
2. 从插件声明的提示词模板拼出**入口提示词**；
3. spawn 一个 `claude` 交互式进程（`stdio: inherit`），把控制权交给用户与 Claude Code。

规划产物（需求文档 / WBS / 任务列表）由 Claude Code 会话内的 `w-plan` 流程经 `awf-state` MCP 写入 `.awf/state.json`，CLI 侧不写 state。

## 执行流程

```
planCommand(description, options)
  ├─ 0. 非 --resume：archiveOldStateForPlan(cwd)   # state.js
  │       archived   → info "检测到旧 plan 状态，已归档：<path>"
  │       run-active → info "检测到 run 运行中（mode=run/pause），跳过 plan 重置"
  │       none       → 无输出
  ├─ 1. 版本号（暂时禁用，setupVersion 已注释）
  ├─ 2. 本地注册（已移至 awf init，plan 不再处理）
  └─ 3. spawnClaude(cwd, await planEntry(description, options.resume))
          logger.info('启动规划会话...') → logger.info(`  ${prompt}\n`)
          interactive.launchDialog({ cwd, prompt })   # 端口经 ports.cjs 契约取用
          logger.success('规划会话结束')
```

### 步骤 0：残留 state 归档（`archiveOldStateForPlan`）

非 `--resume` 时执行，三态返回：

| 返回 `action` | 触发条件 | CLI 行为 |
|---------------|----------|----------|
| `run-active` | `state.mode` 为 `run` / `pause` | 跳过，不归档（避免打断进行中的 run） |
| `none` | state 不存在，或无 tasks/wbs/plan/milestones 内容 | 无输出 |
| `archived` | 有旧内容且非 run 态 | 归档到 `.awf/versions/state-<ts>.json`，state 重置为 `{mode:'plan', currentState:'PLAN', milestones:[], tasks:[], wbs:[], plan:{}}`（保留 `version`） |

### 步骤 3：入口提示词与进程启动

- 提示词由 `plugin-bridge.planEntry` 从 `plugin/plugin-code/prompts.json` 读取并填充 `{desc}` 占位符（**CLI 零感知插件命令字符串**）。
- 进程启动由 `src/adapters/interactive.cjs` 的 `launchInteractiveClaude` 完成（`claude` 字面只在该 adapter）。

## 核心常量 / 配置

| 常量 | 值 | 说明 |
|------|-----|------|
| prompt key（resume） | `plan-resume` | `--resume` 时取用，无占位符 |
| prompt key（有描述） | `plan-start` | 填充 `{desc}` = 位置参数 |
| prompt key（无描述） | `plan-default` | 无描述且非 resume 时取用 |
| 默认 settings 路径 | `<cwd>/.claude/settings.json` | `launchInteractiveClaude` 的 `settingsPath` 缺省值（`projectSettingsPath`） |
| 默认 skip 权限 | `true` | `launchInteractiveClaude` 的 `dangerouslySkipPermissions` 缺省值 |

`prompts.json` 当前模板内容（供对照，实际以插件文件为准）：

| key | prompt |
|-----|--------|
| `plan-start` | `/ai-workflow-code:w-plan {desc}` |
| `plan-resume` | `/ai-workflow-code:w-plan --resume ...` |
| `plan-default` | `/ai-workflow-code:w-plan 请开始需求规划` |

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `planCommand(description, options)` | 主入口：归档判定 → 拼 prompt → 启会话 | `src/cli/plan.js` |
| `spawnClaude(cwd, prompt)` | plan 内部 helper：日志 + `interactive.launchDialog` + 成功日志 | `src/cli/plan.js` |
| `planEntry(description, resume)` | 按场景选 key 并填充占位符，返回入口提示词 | `src/lib/plugin-bridge.js` |
| `resolvePrompt(key, vars)` | 读 `prompts.json`，替换 `{var}` 占位符 | `src/lib/plugin-bridge.js` |
| `launchInteractiveClaude(opts)` | spawn `claude`（`stdio:'inherit'`）；`code∈{0,null}` resolve，否则 reject | `src/adapters/interactive.cjs` |
| `archiveOldStateForPlan(projectRoot)` | 归档残留 state 并重置为 plan 模板 | `src/lib/state.js` |

## 接口 / 依赖

| 模块 | 用途 |
|------|------|
| `src/lib/plugin-bridge.js` (`planEntry`) | 插件边界唯一模块：入口提示词由插件声明，CLI 只读模板填空 |
| `src/adapters/ports.cjs` (`interactive`) | 端口契约取用（不直连 adapter 文件）；`launchDialog` 包装 `launchInteractiveClaude` |
| `src/lib/state.js` (`archiveOldStateForPlan`) | 非 resume 时的旧 state 归档与重置 |
| `src/lib/ui/log.js` (`logger`) | info / success 输出 |
| `plugin/plugin-code/prompts.json` | `plan-start` / `plan-resume` / `plan-default` 模板（插件侧声明） |

## 验收标准

- [ ] `awf plan "需求"` 拼出的入口提示词为 `plan-start` 模板，`{desc}` 被需求描述替换
- [ ] `awf plan`（无描述）取 `plan-default`，`awf plan --resume` 取 `plan-resume`
- [ ] 非 `--resume` 且存在旧 plan 内容时，state 被归档到 `.awf/versions/` 并重置为空 plan 模板
- [ ] `state.mode` 为 run/pause 时不触发归档/重置
- [ ] 交互进程以 `stdio: 'inherit'` 启动；异常退出（code≠0）时抛错且不输出「规划会话结束」
