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
    "tasks": [ /* 任务列表，prompt 用 /w-dev + XML 结构；多 agent 用例需带 kind(dev/review/test/doc) */ ]
  },
  "expected": {
    "files": ["src/sum.js"],              // 必须存在的产物（含多 agent 的 eval-marker/<taskId>.done）
    "verify": ["node", "--test"],         // 校验命令，退出码 0 = 通过
    "tasksDone": true,                    // 所有任务 status=done 且 exec.result 非空
    "logContain": ["批次 B1 (4): T1, T2, T3, T4"],  // 可选：eval.log 必须含的批次派发标记（多 agent 并行证据）
    "markerFiles": ["eval-marker/T1.done"],          // 可选：并行证据——这些文件 mtime 跨度 < markerSpanMs 才算并行
    "markerSpanMs": 90000
  }
}
```

## 评分维度

1. **任务完成** — 所有任务 `status=done`，且 done 任务 `exec.result` 非空（双证据，防伪完成）
2. **产物存在** — `expected.files` 列出的文件落盘
3. **校验通过** — `expected.verify` 命令退出码 0
4. **多 agent 并行证据**（仅多 agent 用例）：
   - `logContain` — eval.log 含「批次 B1 (N): …」派发标记，证明 CLI 按批次屏障整批派发（而非逐任务串行）
   - `markerSpanMs` — 各任务 marker 文件写入时间跨度上限，证明子任务几乎同时落盘（真并行）；串行执行会因任务依次完成而远超阈值

## 多 agent 用例速查

| 用例 | 配置 | 验证点 |
|------|------|--------|
| `multi-agent-parallel` | `max=9, maxModules=2, maxPerModule=2, maxPerFeature=1` | 4 dev 并发 → 4 review 并行 → 2 test 并行 → doc 独占；批次 banner + marker 时间跨度 |
| `multi-agent-serial-baseline` | `max=1`（同任务集，extends） | 单 agent 串行也能完成同一任务集；与并行用例对比耗时/批次数 |

跑对照：`npm run eval -- --only multi-agent-parallel` 与 `npm run eval -- --only multi-agent-serial-baseline`，比较两例日志中批次数与总耗时。

## 已知限制

- **plan 阶段未自动化** — 用例自备 `seed.state.json`（等价 plan 产物），避开交互式 `awf plan`。plan 阶段的全真评测留待后续（需 headless `claude -p` 或 PTY）。
- **macOS 取向** — `awf run` 会 `spawn('open', ...)` 打开 dashboard，Linux 无 `open` 可能报错。
- **时长** — 每用例默认超时 15 分钟，可用 `AWF_EVAL_TIMEOUT_MS` 覆盖。
