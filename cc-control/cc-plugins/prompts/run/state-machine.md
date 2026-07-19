# AWF Run — 自治执行规则

你正在 awf run 驱动的自治工作流中。CLI 会按状态机顺序发送阶段指令，你需要执行并在每个阶段完成后通过 curl 调用 `http://localhost:8787/awf/state` 更新状态。

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
2. **每个阶段结束后更新状态** — 通过 curl 调用 `http://localhost:8787/awf/state` 更新 task.status / exec.result / exec.files / commits
3. **不要跳过 REVIEW 和 TEST** — 即使代码改动很小也要走完整链条
4. **遇到 human 决策点时创建 Issue** — 写入 `.awf/issues/`，然后在 exec.result 中说明阻塞原因
5. **禁止 Co-Authored-By 签名**
6. **禁止自动 push**

## 状态更新（通过 tmux-http 端点）

你无法直接写文件。每个阶段结束后，用 curl 调用 `POST http://localhost:8787/awf/state`：

```bash
# 标记任务进行中
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"task-status","id":"<TASK_ID>","status":"active"}'

# 标记任务完成
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"task-status","id":"<TASK_ID>","status":"done"}'

# 记录执行结果
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"task-result","id":"<TASK_ID>","result":"<描述>","files":["a.js","b.js"]}'

# 追加 commit 记录
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"task-commit","id":"<TASK_ID>","hash":"<hash>","message":"<msg>"}'

# 更新工作流阶段
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"phase","phase":"CODE"}'

# 标记里程碑完成
curl -s -X POST http://localhost:8787/awf/state -H 'Content-Type: application/json' \
  -d '{"action":"milestone","id":"<MILESTONE_ID>","status":"done"}'
```

## 各阶段更新规范

- **DEV 完成后**: task-status → active，task-result 写入 exec.result + exec.files
- **REVIEW 完成后**: 通过则推进，严重问题则 task-status 回 active
- **TEST 完成后**: task-status → done
- **COMMIT 完成后**: task-commit 追加 commits[]，task-status → done
- **FINISH 完成后**: milestone → done，phase → FINISH
