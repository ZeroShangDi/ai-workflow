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
- **配置/状态单源地基（架构重构 W1）** — `config-loader`（默认值合并 + env 覆盖 + 校验，render 读 loader 渲染）、`runtime-config`（运行期常量收敛到 config+env：端口/会话名单源，插件侧改读注入值）、`run-context` 装配器（sid→路径/会话名/workdir/settings）、`run-id`（sid 生成/校验/派生，与 runStamp 对齐）、`state-schema`（state.json 字段/枚举单源）+ `store-core`（state.lock + 原子写，CLI/server/MCP 三份重复实现归位）+ `migrate` 迁移器骨架；server/CLI/MCP 单例路径与读写改经装配器与 store 核心
- **版本统一 0.2.0** — package / 三 plugin / marketplace / state 对齐 0.2.0（version 单源入 plugin/config.json 经渲染下发）

### Changed
- 渲染器由写死 core/plugin-code 改为按 `marketplace.plugins` 遍历生成（render-config.mjs + plugin-config.js）
- Stop / PreToolUse(AskUserQuestion) hook 命令由裸 curl 改为共享 `hooks/gateway.cjs`（转发 + ccOutput 回传）；hooks 单源仅渲染进引擎插件
- 仓库文档三插件化（README / CLAUDE.md / CHECKLIST / bootstrap 表述一致，不再称双插件）

### Removed
- 旧原型目录 `plugin/awf-decision-system/` 删除；集成设计稿归档 `docs/discuss/decision-system-design.md`（仅供追溯）

> 版本说明：本条目对应 awf state/runStamp 版本 0.2.0（决策闸门里程碑）；npm 包版本见 `package.json`。多 agent 决策闸门后置。
