# v0.2.0 重构恢复审计（2026-09-09）

## 结论

任务图已恢复为可执行顺序，下一核心任务是 T1-105，随后才是 T1-058。为降低恢复阶段的并发变量，`.awf/config.json` 暂时固定单 Agent。旧 run 已中断，state.mode 重置为 idle；从本 worktree 启动时由 `awf run` 正常切回 run。

## 已修复的计划问题

1. T1-105 与 T1-058 的验收重叠已拆开：server 前置与 CLI cutover 分属两个任务。
2. T1-105 plannedFiles 移除 `cli/run.js`、`cli/run-batch.js`，避免执行者再次跨界。
3. T1-058 明确不迁剩余 state/gate 直写，交由 T1-061。
4. 当前 135 个任务 ID 唯一、依赖均存在、无环、无前向依赖；核心链为 T1-105 → T1-058 → … → T1-067 → T1-104 → T3-005。

## 仍需在后续任务处理

- 运行中重规划缺少原子 supersede/requeue 协议，详见 `docs/bugs/t1058-prereq-appended-tail.md`。
- 历史任务 T1-038 以 scaffold 冒充 live cutover 的完成语义，已由 T1-105/T1-058 补偿；后续门禁需验证生产调用链。
- T1-061 与 T1-062 边界接近：前者负责剩余写调用迁 API，后者负责删除/封闭 CLI 侧 state 写 API 并把读切到 client snapshot；执行时不得合并验收。
- T1-063 之前仍存在 kill-by-port/kill-session 风险；在 T1-063 完成前禁止嵌套运行，真 run 仅在隔离 shell 或随机端口 fixture 执行。
- T1-104 是 plan 生命周期缺陷修复，不应阻塞 W3-005 的 CLI 重构模块门禁。建议执行到 T1-067 后把 T1-104 移到 T3-005 之后的独立维护模块，避免无关耦合；本轮未擅自改动该里程碑归属。

## 启动前门禁

1. 当前目录必须是本恢复 worktree 的 `cc-control/` 子目录。
2. `git status` 只允许看到本恢复审计产生的改动。
3. 依赖安装必须通过 frozen lockfile。
4. 完整基线为 689 项：687 通过、2 个既有 E2E 失败；旧 handoff 所述 TC17 已确认通过。失败明细见 `docs/bugs/recovery-baseline-e2e-failures.md`。
5. 启动命令只在本 worktree 执行；不得从当前稳定目录执行，也不得在已有 awf run 会话内嵌套执行。

## 测试基线

- 通过：69 个测试文件、687 个测试。
- 失败：`tests/e2e/e2e-smoke.test.js` 的日志路径断言仍按旧 `.awf/logs/*.log` 布局；实际 logger 已输出到 `.awf/logs/<runStamp>/`。
- 失败：`tests/e2e/run.e2e.test.js` 的多 Agent 分流用例在 20 秒超时；需隔离判断是假计时/cleanup 问题还是 scheduler 挂起。
- 两项均发生在 T1-105 实现前，后续差异测试以“不新增失败”为最低门槛，但 T1-098 前必须清零。
