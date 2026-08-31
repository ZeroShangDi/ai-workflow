# w-monitor

在当前项目目录的非 tmux Claude Code 会话中，常驻监控 `awf run` 管理的 tmux Claude Code。每 3 分钟派发一次独立侦查 Agent；正常时继续等待，发现异常后立即进入激活状态，暂停 CLI 编排，持续修复到恢复正常或需要用户介入。

本命令只监控 tmux 中 Claude Code 是否正常工作。MCP、Skill、Session Server 和 CLI 仅作为观测或修复手段，不是首版监控对象。

## 角色分工

- **w-monitor（主监控）**：常驻、计时、派发侦查与修复、维护异常次数、暂停/恢复 CLI、写监控日志、决定退出或转人工。不要自行读取完整 pane 或承担具体修复。
- **awf-monitor-probe（侦查 Agent）**：一次性读取 pane、运行日志与必要 state，对比上次快照，判断正常、异常或 run 已结束；只返回结构化结果。
- **awf-monitor-repair（修复 Agent）**：在 CLI 已暂停后读取完整现场，执行一次修复并验证；只返回结构化结果。

主监控只保留最近一次侦查摘要、异常指纹和修复次数。pane、错误堆栈和修复推理留在子 Agent 上下文中。

## 启动条件

1. 读取 `.awf/state.json` 并查询 tmux session。
2. 仅当 `mode=run` 且 tmux session 存在时启动监控。
3. 若 `awf run` 尚未运行，提示后立即退出，不空闲守候。
4. 创建内存态基线：`checkNumber=0`、`lastProbe=null`、`activeError=null`、`repairAttempts=0`、`cliPaused=false`。
5. 确保 `.awf/logs/` 存在。监控日志固定写入 `.awf/logs/w-monitor.jsonl`。

## 监控循环

### 未激活状态

1. 等待 3 分钟；首次启动可立即侦查一次。
2. `checkNumber += 1`。
3. 用 Agent 工具派发一个前台子 Agent（`subagent_type: ai-workflow-core:awf-monitor-probe`），传入检测序号和 `lastProbe`；由它自行读取现场。必须等待它返回后再继续本轮。
4. 严格解析最后一行 `PROBE_RESULT`：
   - `normal`：用本次摘要替换 `lastProbe`，设置下次检查时间，继续等待；正常检测不写日志。
   - `run_finished`：写一条退出日志并结束 `w-monitor`。
   - `abnormal`：保存异常指纹，写异常日志，进入激活状态。
5. 侦查 Agent 输出无法解析时，视为本次侦查失败；重新派发一次。连续两次无法解析才按“无法分类的异常”激活修复。

### 激活状态

发现异常后不再回到 3 分钟轮询，也不因单次修复没有结果而退出。主监控持续执行通用修复闭环，直到：

- 修复成功并恢复 CLI；或
- 同一异常两次修复失败，保持 CLI 暂停并通知用户。

## 通用修复闭环

通用流程只在本节定义；各错误场景只提供专属识别与修复策略，不重复暂停、日志、重试和恢复逻辑。

1. **复核异常**：立即派发新的侦查 Agent。若异常已自行消失，记录恢复并返回未激活状态，不暂停 CLI。
2. **暂停编排**：直接调用 `awf_mode({ mode: "pause" })`（遵循 `w-pause` 协议），再用 `awf_read_state` 确认 state 已进入 `pause`，并等待 CLI 不再派发新任务。不要把 `/w-pause` 发送给正在工作的 tmux CC；任何修复动作（包括 `Ctrl-C`）之前都必须完成此步。
3. **记录现场**：向 JSONL 写入时间、检测序号、错误来源、错误类型、指纹、证据、当前任务及暂停结果。
4. **派发修复**：`repairAttempts += 1`，用 Agent 工具派发一个前台子 Agent（`subagent_type: ai-workflow-core:awf-monitor-repair`），传入异常报告、当前尝试次数和前次修复摘要；必须等待返回，禁止同一异常并行派发多个修复 Agent。
5. **持续验证**：修复 Agent 返回后立即派发侦查 Agent复核，不等待下一个 3 分钟周期：
   - 已恢复：记录成功；直接调用 `awf_mode({ mode: "run" })`；再次读取 state 确认恢复，并确认 CLI 重新编排；清空异常与修复计数；返回未激活状态。
   - 仍为同一异常且尝试少于 2 次：记录失败，立即派发第二次修复，并要求更换方案。
   - 变成新异常：记录场景转换，以新指纹重新进入修复，但总介入链不得无限循环。
   - 需要用户或第二次仍失败：记录升级；保持 CLI 暂停；向用户报告后结束监控。
6. **恢复不变量**：只有侦查 Agent 提供恢复证据后才能恢复 CLI；不得仅凭修复 Agent 自报成功恢复。

`Ctrl-C` 是升级动作，不是默认修复。仅当 CC 当前执行阻止温和介入、场景策略明确要求，且 CLI 已确认暂停时使用。

## 异常领域

侦查 Agent 先判断错误来源，再判断具体类型。正常运行不是错误场景。

### Claude Code 自身异常

- `cc_process_exit`：CC 进程退出或 tmux 中已回到 shell。
- `cc_service_error`：API、服务连接、限流或认证类错误导致无法继续。
- `cc_context_error`：上下文耗尽、压缩失败或内部上下文错误。
- `cc_unresponsive`：CC 长时间无响应且没有任务进展证据。

Claude Code 自身异常采用保守恢复，优先保留现场与当前任务；无法安全恢复会话时转用户介入。

### awf run 执行异常

- `run_task_error`：当前任务的命令、测试、构建或工具调用明确报错。
- `run_timeout`：任务超过合理时间且相对上次侦查没有进展。
- `run_stalled`：CC 仍存活，但 pane、任务、Agent 或阶段均未推进。
- `run_error_loop`：同一错误、失败命令或无效策略重复出现。
- `run_interrupted`：任务或 run 在未完成、未结算时意外停止。
- `run_state_mismatch`：state 与 pane 中的实际执行结果明显不一致。
- `run_unknown`：已确认不正常，但无法归入以上类型。

具体策略由 `awf-monitor-repair` 维护。所有未识别异常必须进入 `run_unknown` 通用兜底，不得因缺少场景而放弃处理。

## 侦查返回协议

侦查 Agent 的最后一行必须且只能使用：

```text
PROBE_RESULT: {"status":"normal|abnormal|run_finished","errorType":null,"fingerprint":null,"evidence":[],"summary":"","needsRepair":false,"snapshot":{}}
```

`snapshot` 只能包含供下次比较的紧凑状态，不得包含完整 pane 或大段日志。

## 修复返回协议

修复 Agent 的最后一行必须且只能使用：

```text
REPAIR_RESULT: {"status":"repaired|failed|needs_user","errorType":"","fingerprint":"","attempt":1,"actions":[],"evidence":[],"summary":""}
```

## 日志协议

`.awf/logs/w-monitor.jsonl` 每行一个 JSON 对象。正常检测不记录，只记录：

- `monitor_started` / `monitor_exited`
- `error_detected`
- `cli_paused` / `cli_resumed`
- `repair_started` / `repair_finished`
- `user_escalated`

每条至少包含：

```json
{"timestamp":"ISO-8601","event":"error_detected","checkNumber":3,"errorType":"run_timeout","fingerprint":"...","attempt":0,"evidence":[],"actions":[],"result":""}
```

禁止记录密钥、令牌或未脱敏的敏感信息；证据只保留定位所需的最小片段。

## 输出规则

- 未激活时保持安静，只在启动、异常、恢复、转人工和退出时通知用户。
- 修复成功：说明异常类型、尝试次数和已恢复 CLI。
- 转人工：说明异常证据、两次修复动作及失败原因，并明确 CLI 仍处于暂停状态。
- `awf run` 正常结束后，`w-monitor` 自动退出。
- CLI 异常退出会保留 tmux 与 Session Server 现场及 `mode=run`，不得把它当作正常结束。

## 运行前置

主动修复依赖 `w-pause` 真正暂停 CLI 编排并支持恢复。若无法确认 `mode=pause` 或 CLI 仍在派发任务，不得开始修复；记录 `user_escalated` 并通知用户先补齐暂停能力。
