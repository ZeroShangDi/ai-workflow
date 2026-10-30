# 测试体系建设 需求文档

> **状态：已落地**（2026-09-12 校对）—— 本文件是测试体系的**原始需求文档**（历史留档）。
> 目标已全部达成，下表「验收标准」逐项打勾并附第一手证据；正文中「本次聚焦」「当前」等**时效性表述保留写作时的原貌**，读时以本节与文末验收表为准。
> 现状核对命令：`npm test`（vitest）、`npm run test:real`（真机回归）、`npm run eval -- --list`（能力测评用例清单）。

## 背景与目标

cc-control **写作当时**零自动化测试，所有核心模块（CLI 命令、MCP Server、Session Server）均未覆盖。目标建立「能用」层的完整测试体系，确保程序稳定运行。

> 校对（2026-09-12）：`npm test` 为 **98 文件 / 918 例全绿**。「零测试」是本文的**起点**，不是现状 —— 现状见文末验收标准。

## 两层结构

| 层级 | 目标 | 说明 |
|------|------|------|
| 固定测试（优先） | 保证能用 | 单元 + 集成 + E2E，vitest 框架 |
| 能力测评（远期） | 证明好用 | 对比纯模型 vs cc-control vs 完整工作流的评分体系 |

本次聚焦固定测试，能力测评仅产出设计文档。

## 功能范围

- 包含：
  - vitest 测试基础设施搭建
  - 13 个能力模块的单元测试和集成测试
  - E2E 烟雾测试（awf run 完整链路）
  - 能力测评方案设计文档
- 不包含：
  - CI 管道接入（后续再做）
  - 能力测评代码实现（先出方案）
  - Prompts/Templates 等纯内容文件的测试

> 校对（2026-09-12）：范围四条均已交付。「不包含」三条中，**第 2 条已越出原范围** —— 能力测评不止出了方案，还落成了可跑的用例套件（`scripts/eval.sh` + `tests/eval/cases/`，`npm run eval -- --list` 列出 10 个 case）；CI 管道与纯内容文件测试仍未做（见文末「仍未做」）。

## 验收标准

- [x] vitest 配置完成，`npm test` 可运行
      —— `vitest.config.js`；`npm test` = `vitest run`，**98 文件 / 918 例全绿**（2026-09-12 实测）。
- [x] 13 个模块均有测试用例，覆盖核心路径和边界条件
      —— 实际超出「13 个模块」的分法：测试按 `tests/unit` / `tests/integration` / `tests/e2e` / `tests/regression` / `tests/eval` 五个面组织，共 98 个测试文件；
      逐模块的用例文档见 `docs/features/*.test.md`（15 份，含本轮的 `web.test.md`）。
- [x] E2E 烟雾测试可验证 awf run 完整链路
      —— 两层：`tests/e2e/`（`e2e-smoke.test.js` / `run.e2e.test.js`，进 `npm test`）与**真机回归** `tests/regression/fullflow-regression.mjs`（真 tmux + 真 claude + 真 server，`npm run test:real`）；
      2026-09-12 全量连跑 **15 case / 204 断言全绿、exit 0**（一轮约 10 分钟）。
- [x] 所有测试 `npm test` 通过
      —— 918/918。
- [x] 能力测评方案文档产出
      —— `docs/features/eval-design.md`；并已落地可运行的 eval 套件（`npm run eval`）。

### 校对时的补充（超出原验收）

| 能力 | 落点 | 证据 |
|---|---|---|
| 真机回归（全链路，非 mock） | `tests/regression/fullflow-regression.mjs` | `npm run test:real`；全量连跑 15 case / 204 断言全绿 |
| 结构化架构门禁 | `scripts/check-architecture.mjs` | `npm run check:arch`，进 `npm run build` |
| 能力测评（声明式评分 + 运行中钩子） | `scripts/eval.sh`、`tests/eval/cases/` | `npm run eval -- --list` 列出 10 case |

### 仍未做（原「不包含」中仍成立的）

- **CI 管道接入** —— 仓库无 `.github/workflows`；全部测试靠本地/人工触发，无 CI 编排。
- **Prompts / Templates 等纯内容文件的测试** —— 仍无（`awf init` 模板渲染有单测，但提示词内容本身不测）。

