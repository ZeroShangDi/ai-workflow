# 全真 E2E 评测（eval）

真实驱动 `claude` + `tmux` + 插件跑完整 `awf init → run` 链路，**消耗真实 token**。

与 `tests/` 下的确定性测试不同：

| 维度 | 确定性测试（vitest） | 全真 eval |
|------|---------------------|-----------|
| 代理 | 脚本替身（deterministic） | 真实 Claude Code |
| 成本 | 0 | 每用例消耗 token |
| 运行 | `npm test` 自动跑 | 仅按需手动跑 |
| 目的 | 验证编排器逻辑正确 | 验证真实产出质量 |

## 前置条件

- `claude` 已安装且登录（`claude` 在 PATH）
- `tmux` 已安装
- `node` 在 PATH

缺失时会立即中止（在消耗 token 之前）。

## 运行

```bash
# 全部用例
npm run eval

# 单个用例
npm run eval -- --only hello-sum

# 单个多 agent 用例（awf run 的 CLI 输出会实时显示，并同时写入 eval.log）
node tests/eval/run-eval.mjs --only multi-agent-parallel

# 列出所有用例（不运行）
node tests/eval/run-eval.mjs --list

# 保留沙箱（默认成功用例会清理，失败用例始终保留日志）
node tests/eval/run-eval.mjs --keep
```

## 用例结构

每个用例一个目录 `tests/eval/cases/<id>/case.json`：

```json
{
  "id": "hello-sum",
  "name": "人类可读名",
  "requirements": "原始需求（给人看）",
  "extends": "other-case-id",             // 可选：继承另一用例（seed 合并；config/files/expected 全量覆盖），对照用例复用任务集
  "config": { "run": { "agents": {...} } }, // 可选：写入沙箱 .awf/config.json；run.agents.max>1 → 走多 agent 批次循环
  "files": { "package.json": "..." },     // 可选：run 前写入沙箱的额外文件
  "seed": {                               // 等价于 plan 产物的 state.json
    "tasks": [ /* 任务列表，prompt 用 /ai-workflow-code:w-dev + XML 结构；多 agent 用例需带 kind(dev/review/test/doc) */ ]
  },
  "expected": {
    "files": ["src/sum.js"],              // 必须存在的产物（含多 agent 的 eval-marker/<taskId>.done）
    "verify": ["node", "--test"],         // 校验命令，退出码 0 = 通过
    "tasksDone": true,                    // 所有任务 status=done 且 exec.result 非空
    "logContain": ["[T1]", "[T2]"],                 // 可选：eval.log 必须含的任务状态事件（多 agent 派发证据）
    "markerFiles": ["eval-marker/T1.done"],          // 可选：并行证据——这些文件 mtime 跨度 < markerSpanMs 才算并行
    "markerSpanMs": 90000
  }
}
```

> ⚠️ **命令必须用插件命名空间形式**（`/ai-workflow-code:w-dev`，不是 `/w-dev`）。
> 裸名在插件化改造后已不再解析，写成裸名的用例会表现为「任务永不结算、挂到超时」——
> **整套 eval 曾因此静默失效**（`.awf/issues/007`）。新增用例务必用命名空间命令并实跑一次。

## 运行中钩子（可选）：`hooks.mjs`

声明式 `case.json` 只能「跑完看结果」。有些能力的关键动作发生在 run **进行中**（例如人工批准一次
动态规划 proposal），此时在用例目录放一个 `hooks.mjs`：

```js
// tests/eval/cases/<id>/hooks.mjs
export async function duringRun({ readState, get, post, sleep }) { return { checks: [{ ok: true, msg: '…' }] }; }
export async function afterRun({ readState, sandbox }) { return { checks: [] }; }
```

- 两者都与 `awf run` **并发**执行（runner 先起 run，再调 `duringRun`，最后 `await` run 结束）；
- `get` / `post` 打本项目 server（自动带 `?p=<sandbox>`），端口与 `awf run` 同源；
- 返回的 `checks` 并入该用例评分；
- 参考实现：`tests/eval/cases/dynamic-planning/hooks.mjs`。



1. **任务完成** — 所有任务 `status=done`，且 done 任务 `exec.result` 非空（双证据，防伪完成）
2. **产物存在** — `expected.files` 列出的文件落盘
3. **校验通过** — `expected.verify` 命令退出码 0
4. **多 agent 并行证据**（仅多 agent 用例）：
   - `logContain` — eval.log 含任务状态事件（如 `● [T1]`），证明 CLI 已派发对应任务
   - `markerSpanMs` — 各任务 marker 文件写入时间跨度上限，证明子任务几乎同时落盘（真并行）；串行执行会因任务依次完成而远超阈值

## 多 agent 用例速查

| 用例 | 配置 | 验证点 |
|------|------|--------|
| `multi-agent-parallel` | `max=9, maxModules=2, maxPerModule=2, maxPerFeature=1` | 4 dev 并发 → 4 review 并行 → 2 test 并行；doc 按 plannedFiles 判定并行，commit 独占；批次 banner + marker 时间跨度 |
| `multi-agent-serial-baseline` | `max=1`（同任务集，extends） | 单 agent 串行也能完成同一任务集；与并行用例对比耗时/批次数 |

跑对照：`npm run eval -- --only multi-agent-parallel` 与 `npm run eval -- --only multi-agent-serial-baseline`，比较两例日志中批次数与总耗时。

## 已知限制

- **plan 阶段未自动化** — 用例自备 `seed.state.json`（等价 plan 产物），避开交互式 `awf plan`。plan 阶段的全真评测留待后续（需 headless `claude -p` 或 PTY）。
- **macOS 取向** — `awf run` 会 `spawn('open', ...)` 打开 dashboard，Linux 无 `open` 可能报错。
- **时长** — 每用例默认超时 15 分钟，可用 `AWF_EVAL_TIMEOUT_MS` 覆盖。
