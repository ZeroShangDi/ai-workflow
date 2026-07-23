# AWF Run — 自治执行规则

你正在 awf run 驱动的自治工作流中。CLI 会按状态机顺序发送阶段指令，你需要执行并在每个阶段完成后更新 state.json。

## 状态机（run 范围）

```
CODE ──→ REVIEW ──→ TEST ──→ COMMIT ──→ FINISH ──→ (下一个 task or FINISH)
  ↑         ↑          ↑
  └── DEBUG ─┘          │
       ↑                │
       └── 任一阶段遇 bug 即切入
                          
DOCS 可在任意阶段触发。
```

## 核心规则

1. **一次只做一件事** — 收到哪个阶段的指令就只执行那个阶段，不越界
2. **每个阶段结束后更新状态** — 通过 awf-state MCP tools 更新状态（详见下方）
3. **阶段链由 CLI 决定，你不需要关心** — 按收到的阶段指令执行。复杂度对应：
   - simple（配置/文案）→ DEV → COMMIT
   - medium（bugfix/优化，默认）→ DEV → TEST → COMMIT
   - complex（新模块/架构）→ DEV → DOCS → REVIEW → TEST → COMMIT
   - featureGroup 最后一个任务会自动触发完整集成 TEST + DOCS
4. **遇到 human 决策点时创建 Issue** — 写入 `.awf/issues/`，然后在 exec.result 中说明阻塞原因
5. **禁止 Co-Authored-By 签名**
6. **禁止自动 push**

## 状态更新（通过 awf-state MCP tools）

你无法直接写文件。每个阶段结束后，使用 MCP tools 更新状态：

| 操作 | MCP Tool | 参数 |
|------|----------|------|
| 标记任务进行中 | `awf_task_status` | `id:"<TASK_ID>", status:"active"` |
| 标记任务完成 | `awf_task_status` | `id:"<TASK_ID>", status:"done"` |
| 记录执行结果 | `awf_task_result` | `id:"<TASK_ID>", result:"<描述>", files:["a.js"]` |
| 追加 commit | `awf_task_commit` | `id:"<TASK_ID>", hash:"<hash>", message:"<msg>"` |
| 更新阶段 | `awf_phase` | `phase:"CODE"` |
| 标记里程碑完成 | `awf_milestone_update` | `id:"<MILESTONE_ID>", status:"done"` |

其他 tools: `awf_read_state`, `awf_task_create`, `awf_task_update`, `awf_task_delete`, `awf_plan_configure`, `awf_wbs_create`, `awf_wbs_update`, `awf_wbs_delete`, `awf_milestone_create`

### Curl 回退（MCP 不可用时）

```bash
curl -s -X POST http://localhost:8787/awf/state \
  -H 'Content-Type: application/json' \
  -d '{"action":"task-status","id":"<TASK_ID>","status":"done"}'
```

## 各阶段更新规范

- **DEV 完成后**: task-status → active，task-result 写入 exec.result + exec.files
- **REVIEW 完成后**（仅 complex 任务）: 通过则推进，严重问题则 task-status 回 active
- **TEST 完成后**（medium+ 任务）: task-status → done
- **COMMIT 完成后**: task-commit 追加 commits[]，task-status → done
- **FINISH 完成后**: milestone → done，phase → FINISH
