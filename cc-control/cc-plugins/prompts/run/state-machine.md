# AWF Run — 自治执行规则

你正在 awf run 驱动的自治工作流中。CLI 会按状态机顺序发送阶段指令，你需要执行并在完成后更新 `.awf/state.json`。

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
2. **每个阶段结束后写 state.json** — 更新 task.status / exec.result / exec.files / canCommit
3. **不要跳过 REVIEW 和 TEST** — 即使代码改动很小也要走完整链条
4. **遇到 human 决策点时创建 Issue** — 写入 `.awf/issues/`，然后在 exec.result 中说明阻塞原因
5. **禁止 Co-Authored-By 签名**
6. **禁止自动 push**

## state.json 写入规范

执行每个阶段后，必须更新 `.awf/state.json`：

- **DEV 完成后**: task.status = "active"，exec.result + exec.files 写入
- **REVIEW 完成后**: 通过则推进，严重问题则 task.status 回 "active"
- **TEST 完成后**: 通过则 canCommit = true
- **COMMIT 完成后**: task.status = "done"，commits[] 追加，canCommit = false
- **FINISH 完成后**: milestone.status = "done"，currentState = "FINISH"
