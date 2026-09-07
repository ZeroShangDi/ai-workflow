# Changelog

格式参考 Keep a Changelog + 语义化版本。重点概括项目级版本变迁，细节见各功能文档 / 开发日志。

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added
- **ai-workflow-decision 独立插件（决策闸门 v0.2.0，单 agent）** — 渲染器/配置泛化支持三插件市场（core / decision / plugin-code），config + settings 注册第三插件；决策技能与协议资产落地（decision-core / decision-workflow SKILL + PROTOCOL + decision-result.schema + mode-instruction）
- **run.decision.enabled 配置开关**（缺省 false = 旧上抛逻辑不变；server/CLI 单源判定防漂移）
- **单 agent 决策闸门两入口**：文字 `<AWF_DECISION_REQUIRED>` 与 AskUserQuestion → 当前会话切 DC 产出 Decision Result；Stop/PreToolUse decision-aware + hook gateway 命令（stdout 输出 block/deny）
- **决策闭环**：结果解析/轻量校验/deferred fallback/防递归（一次事务闭合一次）；决策记录追加式 jsonl（`.awf/decisions/runs/`）+ run 日志事件对齐
- **Review 数据 API 与页面**：GET /awf/decisions + POST override + decisions.html 页面；override → 追加纠偏任务（kind=dev / source=decision_review），runLoop 下一轮拾取
- **测试与文档**：gate on/off 双路径集成套件 + 单元测试 + real-server 冒烟证据；决策系统功能/测试用例文档

### Changed
- 渲染器由写死 core/plugin-code 改为按 `marketplace.plugins` 遍历生成（render-config.mjs + plugin-config.js）
- Stop / PreToolUse(AskUserQuestion) hook 命令由裸 curl 改为共享 `hooks/gateway.cjs`（转发 + ccOutput 回传）；hooks 单源仅渲染进引擎插件
- 仓库文档三插件化（README / CLAUDE.md / CHECKLIST / bootstrap 表述一致，不再称双插件）

### Removed
- 旧原型目录 `plugin/awf-decision-system/` 删除；集成设计稿归档 `docs/discuss/decision-system-design.md`（仅供追溯）

> 版本说明：本条目对应 awf state/runStamp 版本 0.2.0（决策闸门里程碑）；npm 包版本见 `package.json`。多 agent 决策闸门后置。
