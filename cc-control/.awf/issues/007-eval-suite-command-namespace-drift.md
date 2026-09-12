---
id: "007"
title: "eval 套件整体失效：case 里的命令命名空间已过期（/w-dev → /ai-workflow-code:w-dev）"
status: open
labels: [bug, tooling, eval, legacy]
assignee: null
milestone: null
priority: high
created: 2026-09-11
updated: 2026-09-11
deps: []
related: ["T3-011", "006"]
---

# eval 套件整体失效：case 里的命令命名空间已过期

**一句话**：`tests/eval/` 全部 case 的 prompt 仍写 `/w-dev`，而命令早已归属 `ai-workflow-code` 插件；Claude 收到后只回一句 `Unknown command: /w-dev`，任务永不结算，用例逐个跑到超时。**不是慢，是整套已经死了。**

## 一、怎么发现的

2026-09-11 为动态任务规划新增 eval 用例（`tests/eval/cases/dynamic-planning/`）后首次实跑，卡在 T1 不动。
用**未改动的**已知用例 `hello-sum` 做对照，同样卡住 —— 于是排除「新用例写坏了」。抓 tmux pane 拿到根因：

```
⏺ Unknown command: /w-dev
⏺ Args from unknown skill: <task>
  ...
```

会话、server、host 全都正常（`state=mode:run`、`T1=active`、`sessionState=busy`、SessionStart 已到），
**卡在第一步：命令根本不存在**。

## 二、影响面（2026-09-11 逐 case 扫过）

| 用例 | 情况 | 受影响 |
|---|---|---|
| `hello-sum` | prompt `/w-dev` | ✅ 实测挂死（对照用） |
| `multi-task-deps` | prompt `/w-dev` | ✅ |
| `review-gate-closure` | prompt `/w-dev`、`/w-review` | ✅ |
| `multi-agent-parallel` | prompt `/w-dev`、`/w-review`、`/w-test`、`/w-doc` | ✅ |
| `multi-agent-serial-baseline` | 无自带任务，`extends: multi-agent-parallel` | ✅（继承上面的任务集） |
| `full-suite` / `needs-input-probe` / `needs-input-suspend` / `subagent-hooks-probe` | 任务 prompt 是自由文本，**不调 slash 命令** | ❓ 与本失效模式无关；**未实跑**，不能据此说它们可用 |
| `dynamic-planning`（新增） | 已用 `/ai-workflow-code:w-dev` | ✅ 实测 1/1 通过 |

合计 **5 个受本问题影响**（4 个直接 + 1 个继承），另有 4 个不受此模式影响但状态未经实跑确认。

- 症状具有欺骗性：不是报错退出，而是**挂到超时**（runner 默认 900s/用例），容易被读成「模型慢」。
- 与 `tests/regression/` 的对照最能说明问题：那边用的是 `/ai-workflow-code:w-dev`，一直正常 ——
  典型的「一套跟着插件改名走了，另一套留在原地」。

## 三、根因

插件化改造后命令按插件命名空间注册（`ai-workflow-code`），裸名不再解析。
eval case 写于改造之前，此后没人跑过全量 eval，于是**没有任何环节会响**：
`npm test` 不收 eval、CI 不跑 eval、`--only` 又是手动入口。

## 四、修法

1. 扫描 `tests/eval/cases/**/case.json`，把 `prompt` 里的裸命令改成命名空间形式
   （`/w-dev` → `/ai-workflow-code:w-dev`，`/w-review` `/w-test` `/w-doc` 同理）——**待改 4 个文件**
   （`hello-sum` / `multi-task-deps` / `review-gate-closure` / `multi-agent-parallel`；
   `multi-agent-serial-baseline` 继承任务集，改完自动跟上）。本仓库已有改好的样例可直接对照：
   `tests/eval/cases/dynamic-planning/case.json`。
2. 复核 `expected.logContain` / `verify` 等字段是否也被同一批改造带偏（如命令名出现在断言里）。
3. **补一条能自动发现这类漂移的检查**：至少让「case 里引用的命令名在插件注册表里存在」可判定，
   否则下次插件再改名，整套 eval 会再次静默死掉（与 issue 003/004 同属「声明与实现不符」）。

## 五、当前决议

- 只登记，不在本轮顺手清扫 —— 用户 2026-09-11 明确：**eval 是遗留问题，后面统一处理**。
- 与另一条待办合并考虑：`tests/eval/` 与 `tests/regression/` 的职责/入口/产物**至少要能区分开**
  （见 `docs/discuss/real-run-suite-merge.md` 的 2026-09-11 追加节）。
- 在清扫完成前，任何「eval 全绿」的说法都不成立；新增 eval 用例必须用命名空间命令并实跑验证。
