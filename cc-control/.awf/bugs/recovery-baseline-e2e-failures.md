# 恢复基线存在两个 E2E 失败

- 状态: resolved（2026-09-10）
- 优先级: high
- 发现: 2026-09-09 恢复审计
- 基线: 69 files passed / 2 files failed；687 tests passed / 2 failed

## 归零记录（2026-09-10）

两个用例按「对齐新链路」而非「扩大超时」修复，另修掉同批暴露的 cli-aux TC11：

| 用例 | 原失败 | 处置 |
|---|---|---|
| `tests/e2e/e2e-smoke.test.js` | 在 `.awf/logs` 顶层扫 `.log` | 改按 per-run 布局读 `.awf/logs/<version-runStamp>/main.log` |
| `tests/e2e/run.e2e.test.js` | 6 例全部按旧 CLI 主循环断言（wrapup 补发 / 追问 / context-check / 多 agent 分流），且固定端口 8787 | 补回宿主侧缺失语义（`task-channel.cjs` 收尾协商+上下文压缩、host 收尾 backupState）后用例转绿；多 agent 改为经宿主 `driveBatch`；端口改随机空闲端口（hermetic），新增 E2E-7 覆盖 `--multi-agent` |
| `tests/unit/cli-aux.test.js` TC11 | 断言 `lsof` 兜底，但 `requestShutdown` 真的打到了并发测试文件占用的 8787 | stub 全局 fetch，拆成 TC11（优雅关闭失败 → lsof 兜底）/ TC11b（优雅关闭成功 → 不 kill-by-port）两条 |

全量：98 文件 / 831 例绿（含新增 `tests/unit/batch-transport.test.js`、`tests/integration/batch-host.test.js`）。

## 失败 1：run logger 断言仍使用旧布局

`tests/e2e/e2e-smoke.test.js` 在 `.awf/logs/` 顶层筛选 `.log` 文件并期待恰好一个，但当前 RunLogger 已把日志写到 `.awf/logs/<version-runStamp>/main.log`。测试与已完成的 per-run 布局迁移不一致。

修复时应通过 RunLogger/store 的公开路径规则定位日志，避免重新硬编码目录；同时断言 header、version、prompt 内容不变。

## 失败 2：多 Agent 分流 E2E 超时

`tests/e2e/run.e2e.test.js` 的 E2E-6 只期望 `runScheduler` 被调用，但 `runCommand` 在 mock 环境中未于 20 秒内结束。需单独检查 mock scheduler、server/tmux cleanup、fake timer 与 `waitForReady` 的组合，不能简单扩大超时掩盖挂起。

## 验收

- 两个用例可重复稳定通过。
- 修复不依赖本机路径或扩大测试超时。
- T1-105 前后测试差异中不得出现新增失败；T1-098 真 run 回归前全套清零。
