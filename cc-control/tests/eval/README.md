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
  "files": { "package.json": "..." },   // 可选：run 前写入沙箱的额外文件
  "seed": {                              // 等价于 plan 产物的 state.json
    "tasks": [ /* 任务列表，prompt 用 /w-dev + XML 结构 */ ]
  },
  "expected": {
    "files": ["src/sum.js"],             // 必须存在的产物
    "verify": ["node", "--test"],        // 校验命令，退出码 0 = 通过
    "tasksDone": true                    // 所有任务 status=done 且 exec.result 非空
  }
}
```

## 评分维度

1. **任务完成** — 所有任务 `status=done`，且 done 任务 `exec.result` 非空（双证据，防伪完成）
2. **产物存在** — `expected.files` 列出的文件落盘
3. **校验通过** — `expected.verify` 命令退出码 0

## 已知限制

- **plan 阶段未自动化** — 用例自备 `seed.state.json`（等价 plan 产物），避开交互式 `awf plan`。plan 阶段的全真评测留待后续（需 headless `claude -p` 或 PTY）。
- **macOS 取向** — `awf run` 会 `spawn('open', ...)` 打开 dashboard，Linux 无 `open` 可能报错。
- **时长** — 每用例默认超时 15 分钟，可用 `AWF_EVAL_TIMEOUT_MS` 覆盖。
