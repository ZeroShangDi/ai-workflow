# 测试体系

三档，各自可独立跑，成本与"问的问题"完全不同 —— **不要用一档的失败去推另一档的结论**。

| 入口 | 跑什么 | 问的问题 | 成本 | 何时跑 |
|------|--------|---------|------|--------|
| `npm test` | `tests/{unit,integration,conformance,e2e}/*.test.js`（vitest） | 代码写得对不对 / 每个平台是否满足同一份契约 | 秒级、确定、无外部依赖 | 每次改动 |
| `npm run test:real -- --fast` | 机制类里**不派模型**的 5 个 | 编排机械在边界上还活着吗 | 分钟级、确定 | 每次改动（可进提交前） |
| `npm run test:real -- --case all` | 全部 10 个机制类 case | 同上（含真 tmux + 真 claude 的异常路径） | **分钟级 + 烧 token** | 提交前 / 里程碑 |
| `npm run test:eval` | 10 个语义类 case | **AI 干得对不对** | **烧 token（昨天一轮约 2 千万）** | 里程碑 / 版本收尾 |

## 两个真机身份（讨论稿 §三 划的线）

```
              同一批"真机跑一次"的用例
                        │
        ┌───────────────┴───────────────┐
   语义类（AI 干得对不对）          机制类（编排机械活不活）
   tests/e2e/cases/<id>/case.json   tests/regression/*.js（命令式）
   npm run test:eval                npm run test:real
   声明式：seed + expected          脚本：会杀进程、发 HTTP、起 server
```

**为什么按这条线分**：失败含义不同 —— 语义类红了可能是"模型这次没做对"（有方差），
机制类红了基本就是链路问题。混在一起，一次失败你不知道该看哪层。

**共同点**：两边都在真沙箱里跑真 `awf run`（真 tmux + 真 claude + 真 server），
沙箱产物落 `sandbox/e2e/` 与 `sandbox/regression/`（gitignore），都可事后复盘。

## 目录约定

```
tests/
  conformance/    （T-P1-05）适配器一致性：对**每个已落地平台**跑同一套端口契约断言
                  adapters.conformance.test.js；平台转正自动进入覆盖，无需新写用例
  harness/        两边共用的原语（按需抽，不为抽而抽）
                  session-env.mjs  读 run 会话里 claude 进程的 CC_* env
  e2e/            语义类：cases/<id>/case.json（+ 可选 hooks.mjs 处理"运行中发生的事"）
                  run-eval.mjs     评分与报告；README.md 是 case.json 的编写指南
  regression/     机制类：fullflow-regression.mjs（单文件注册表 + case 函数）
                  case 上的 `model: false` 标记它不派模型会话 → `--fast` 只跑这些
```

## 编排层测试不看 CLI（T-P1-05）

编排层（`server/runtime`、`server/run`、`server/features`）的测试一律经 `hostFactory` / mock
适配器注入，**不依赖真 tmux、不依赖 CLI**：`tests/conformance/adapters.conformance.test.js` 里
「编排层脱离 CLI 装配」那组就是这个分层的守卫。平台专属行为（真 tmux、真 claude）只在
`tests/regression` / `tests/e2e` 的真机档验证 —— 三档结论不要互相替代。

## 两个入口的公共约定

- **`--awf <path>`**：指定 awf CLI 入口。缺省 `cli/awf.cjs`（新树）。
- **server 入口与 CLI 同源推导**：`cli/awf.cjs` → 隔壁 `server/server.cjs`；`cli/awf.cjs` → `server/server.cjs`。
  机制类 case 有一半**绕过 CLI 直连 server**，只换 CLI 不换 server 会跑出「新 CLI + 旧 server」的混搭，
  结果不可信 —— 所以这条推导是必须的（`--server <path>` 可显式覆盖）。
- **不给选择就不跑**：真机套件误跑要烧 token，`test:real` 不给 `--fast`/`--case` 时报用法退出。
- **命令用插件命名空间**：case 里的 prompt 写 `/ai-workflow-code:w-dev`，不是 `/w-dev`
  （裸名不解析 → 任务永不结算、用例挂到超时，见 `.awf/issues/007`）。

## 加一个用例

- **语义类**（能表述成"跑完看结果"）→ 加 `tests/e2e/cases/<id>/case.json`，
  字段见 `tests/e2e/README.md`；运行中才有的事实（如人工批准、环境采样）用同目录 `hooks.mjs`。
- **机制类**（要在跑的过程中杀进程 / 发 HTTP / 查端口）→ 在 `tests/regression/fullflow-regression.mjs`
  的注册表加一条 + 写 case 函数，`model: false` 若它不派模型。

## 与其他文档的关系

- 两套的合并方案与边界依据：`docs/discuss/real-run-suite-merge.md`（讨论稿，本目录按它分步落地）
- 覆盖缺口清单：见该讨论稿 §五（部分已由机制类的 resume/pause/recover/init/lifecycle/web 补上）
