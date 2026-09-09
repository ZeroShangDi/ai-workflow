# 恢复基线存在两个 E2E 失败

- 状态: open
- 优先级: high
- 发现: 2026-09-09 恢复审计
- 基线: 69 files passed / 2 files failed；687 tests passed / 2 failed

## 失败 1：run logger 断言仍使用旧布局

`tests/e2e/e2e-smoke.test.js` 在 `.awf/logs/` 顶层筛选 `.log` 文件并期待恰好一个，但当前 RunLogger 已把日志写到 `.awf/logs/<version-runStamp>/main.log`。测试与已完成的 per-run 布局迁移不一致。

修复时应通过 RunLogger/store 的公开路径规则定位日志，避免重新硬编码目录；同时断言 header、version、prompt 内容不变。

## 失败 2：多 Agent 分流 E2E 超时

`tests/e2e/run.e2e.test.js` 的 E2E-6 只期望 `runScheduler` 被调用，但 `runCommand` 在 mock 环境中未于 20 秒内结束。需单独检查 mock scheduler、server/tmux cleanup、fake timer 与 `waitForReady` 的组合，不能简单扩大超时掩盖挂起。

## 验收

- 两个用例可重复稳定通过。
- 修复不依赖本机路径或扩大测试超时。
- T1-105 前后测试差异中不得出现新增失败；T1-098 真 run 回归前全套清零。
