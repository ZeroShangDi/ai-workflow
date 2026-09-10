# 真机测试体系合并方案（讨论稿）

> 2026-09-10 · 状态：**方案待评审，未动代码**
> 触发：T1-107 建后即发现与 `tests/eval/` 重复 → 撤回 → 查清两套体系来历与差异。

## 一、现状：两套并存

| | `tests/eval/` | `tests/regression/` |
|---|---|---|
| 出生 | 2026-08-17 `51a0be0 feat: E2E 评测管线`，08-26~08-29 持续扩 case | **2026-09-10** 才进库（`d3286b3` 归位）；此前**未跟踪**躺在 `tests/sandbox/` |
| 本职 | 能力评测 —— 对比「纯模型 / cc-control / awf run」三模式的产出质量（`docs/features/eval-design.md`） | 回归 —— 守编排器不变量（新链路能否跑通 / 双 run 是否隔离） |
| case 形态 | **声明式** `cases/<id>/case.json`（seed + expected） | **命令式**：脚本内注册 case 函数 + 手写 `check()` |
| 断言口径 | 产出质量：`files` / `verify`（跑产物自测）/ `tasksDone` / `logContain` / `fileContain` / `markerSpanMs`（并行证据） | 链路存活 + 不变量：run 收敛 / mode 复位 / 会话名互异 / state 不串 / env 归属 / runStamp |
| 入口 | `npm run eval`（`--only <id>`） | `npm run test:real`（`--case <name>`） |
| 产物 | `sandbox/eval/<case>-<ts>/` + eval.log | `sandbox/regression/<case>/` + `evidence-*.json` |
| 文档 | README + 16KB 设计文档 | 脚本头部注释 |
| 规模 | 9 case（462 行 runner） | 5 case（~620 行脚本） |

### 怎么回事

两条线各写各的，没有对齐：

- **eval 是「评测」起家**：为回答「加了工作流比裸模型强多少」而建的对比实验管线（三模式、5 维指标、评分公式、HTML 报告）。08 月底多 agent 落地时，往里加了带**断言**的 case（`review-gate-closure`、`full-suite`），于是**兼起了回归职能** —— 身份开始混：**设计文档写的是评测平台，实现出来的是「带指标采集的回归套件」**（`run-eval.mjs` 里 `scoreCase()` 打分 + `collectExecutionMetrics()` 采 token/耗时，两者并排）。
- **regression 是临时产物**：T1-098 执行时（跑在已删除的 B worktree 里）为「新链路真 run + 双 run 隔离」临时写的脚本，落在 `tests/sandbox/`，既没进库也没纳入任何体系；昨天归位到 `tests/regression/` —— 等于**又立了第二套**。

### 已经造成的实际损失

- T1-107（「补核心链路 case：门禁失败闭环 / 多 agent 真调度」）**建完即发现整条重复** —— 这两条 eval 里早有，且做得更细（带 verify 脚本与并行证据）。已撤回。
- 我据此写出的「14 项缺口清单」（`real-run-coverage-gaps.md`）**基于单套实读，结论不准**，需按本方案重出。

## 二、目标形态

不是"合成一套"，而是**一件事、两个消费面**：

```
         同一批 case 定义（声明式 case.json）
                   │
        ┌──────────┴──────────┐
   回归消费面               评测消费面
（pass/fail，守不变量）   （指标/基线，无 pass/fail）
   npm run test:real          npm run eval
```

- **跑一次，两个消费面**：断言过不过 + 采指标做基线比较。
- 加一个场景 = 加一个 `case.json`，两个消费面自动带上。

## 三、合并方案

| # | 项 | 做法 |
|---|---|---|
| 1 | case 形态 | 统一为**声明式 `case.json`**（以 eval 为基：成熟、有文档、加 case 即填配置） |
| 2 | 目录 | 收敛到一处（建议 `tests/e2e/cases/<id>/case.json`，两个入口共读；`tests/eval/`、`tests/regression/` 目录消失） |
| 3 | 入口 | `npm run test:real`（回归，pass/fail）+ `npm run eval`（评测，指标/对比）；后者加 `--only` / 前者加 `--case` 的差异保留 |
| 4 | 产物 | 统一 `sandbox/e2e/<case>-<ts>/`（log + evidence + 指标三件套） |
| 5 | 断言表达 | 把 regression 的"链路存活"断言扩成声明字段：`runSettled` / `modeIdle` / `sessionEnvPointsAt` / `stateIsolation` / `logStampPerRun` —— 让脚本形态的 case 能迁进来 |
| 6 | 文档 | eval 的 README + design 文档合并为一份，明确"回归 / 评测"两个身份与各自入口 |

## 四、现有 case 去重清单（14 → 12）

| 保留 | 来源 | 说明 |
|---|---|---|
| `hello-sum` | eval | 单 agent 最小链路 |
| `single` | regression | **与 hello-sum 重叠** → 合并为一个（保留断言更全的一方） |
| `multi-task-deps` | eval | 依赖链 |
| `multi-agent-parallel` | eval | 4 dev 并发 + 门禁分层 + 配额 + 并行证据 |
| `multi-agent-serial-baseline` | eval | 串行对照基线 |
| `review-gate-closure` | eval | **门禁失败闭环**（fail → 派生修复 → 复审） |
| `full-suite` | eval | 全功能（并行 + 门禁流转 + 落账 + 决策上抛） |
| `needs-input-probe` / `needs-input-suspend` | eval | 决策上抛（AskUserQuestion / NEEDS_INPUT 挂起） |
| `subagent-hooks-probe` | eval | 子 agent hooks 落账链路 |
| `gate` | regression | 门禁任务落账 + verdict（与 review-gate-closure 部分重叠，**待复核是否合并**） |
| `multi` | regression | 多 agent 入口（与 multi-agent-parallel 重叠，**大概率合并**） |
| `decision` | regression | **决策门阀（DC 自决 + 续跑注入）—— eval 无此覆盖，保留** |
| `dual` | regression | **双 run 多项目隔离 —— eval 无此覆盖，保留** |
| （环境归属断言） | regression | `sessionEnvPointsAt` / 会话名互异 / 日志目录互异 —— 并入各 case 的声明字段 |

## 五、两套合并后**仍缺**的覆盖（初步核对，落地时逐条复核）

| 场景 | 说明 |
|---|---|
| 收尾协商 | wrapup → 3 轮追问 → 标 blocked（现仅 mock e2e） |
| 上下文压缩 | context-check → 快照 → /clear 注入 |
| `--resume` / `--attach` | 重连续接、pause 闩锁语义 |
| pause + w-monitor 介入 | `/intervene`、`/intervene/interrupt`、编排闩锁 |
| 中断恢复 | run 崩 → 现场保留 → 续接 |
| 前端页面 | 四视图 / 项目切换条 / 决策 override 页 |
| 常驻 server 生命周期 | 空闲回收、多项目复用 |
| `awf init` 产出 | settings 注入 / `.mcp.json` / 插件注册正确性 |
| commit 流程 / `w-doc` | 文档生成 |
| 多 agent 负向验证 | 配额上限、plannedFiles 冲突、独占 commit 是否真被**拦截**（`multi-agent-parallel` 配了配额，是否有断言需复核） |
| `awf plan` | **暂不做**（用户 2026-09-10 裁定；交互式入口，自动化需 tmux 应答器） |

## 六、迁移步骤（分步、不改行为，可随时停）

1. **定 expected 扩展字段**（表 5 那批），只加字段不迁 case —— 此时两套仍各自可跑。
2. **迁 regression 的 5 个 case 成 `case.json`**，与 eval 的 case 同目录；跑通后逐一比对断言等价。
3. **去重**（表 4）：合并 `single`/`hello-sum`、`multi`/`multi-agent-parallel`，复核 `gate`。
4. **统一入口与产物目录**，旧入口保留一个版本期做别名并标注弃用。
5. **文档收敛**：两套 README/设计文档合一，写清回归 vs 评测两个身份。
6. **补缺口 case**（表 5），此时 T1-108/109 重述为"补哪几个 case"而不是"写一套"。

## 七、开放问题（待评审定）

1. **评测套件（三模式对比 / 评分模型 / HTML 报告）还要不要？**
   `eval-design.md` 描述的能力大部分**尚未实现**（文档里有 Phase 1/2 之分）。要就说清它和回归套件的关系与排期；不要就把该文档标注为历史设计。
2. **`expected` 字段扩到什么程度**？扩 `runSettled`/`stateIsolation` 这类是必要的；但继续扩会让 case.json 变成"半个脚本"，边界要定。
3. **eval 现有 case 的 `verify` 内联脚本很长**（几百字符 `node -e`），是否抽成 `verify/*.mjs` 文件？
4. **入口命名**：`test:real` / `eval` 二者名字是否要按"回归 / 评测"语义重命名。
