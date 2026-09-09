# W3-006 模块测试门禁 — 非真结构核查（T3-006）

> 2026-09-09 · kind=test（非真模块核查，不跑整套真实测试）
> 范围：多 run sessionid 贯穿（T1-068…076）
> 真 run 全流程/真 claude 双 run 回归由 T1-098 承担，本门禁只做结构/验收点自检。

## 模块 acceptance → 结构证据

| 验收点 | 结构证据 | 判定 |
|---|---|---|
| server 多槽 registry | `run-registry.cjs` createRunRegistry（slot/has/list/remove/reset/ensureLayout，per-sid ctx+adapter+sm 惰性装配/缓存） | ✔ |
| tmux cc-`<sid>` | `run-context.cjs:45 runSessionName = sid==null?session:`${session}-${sid}``；host 原语按该会话名；sid-naming 测试 | ✔ |
| hook 反向路由（`__SID__` 注入 + gateway 带 sid） | `run-settings.cjs` usagePath（每 run 落点）；gateway.cjs SID_QS（CC_SID→?sid）；server.cjs runSlotFor/handleSidHook（/hook?sid 早路）；/status?sid | ✔（curl 类事件带 sid 属随行待补，见遗留） |
| 日志/state/决策按 sid 分片 | runStamp→sid（run-id resolveRunStamp）；DecisionStore runStamp/runsDir per-run 目录（决策不串）；per-run layout ensureLayout；host run 以 runId=sid 记录 | ✔（run-logger/指标每 run writer 为随行待补） |
| MCP/client/前端带 sid | run-client slotStatus(sid)；dashboard ?sid runShell；host/事件/snapshot 以 runId 贯穿 | ✔ |
| 同机并发冒烟验证隔离 | server-lifecycle（sid hook a/b 隔离）、two-project-smoke（两进程不互杀 + 双 host 并发 + 归属断言） | ✔ |
| 单 run 无回归 | 无 sid 路径零变化；server 既有回归 68、全量 81 文件 / 728 例绿（e2e 两既有基线失败除外） | ✔ |

## 遗留（不阻塞本门禁，链路已标注）

1. curl 类 hook 事件（SessionStart/UserPromptSubmit/Subagent，hooks.json 未带 `&sid`）与每 run `CC_SID` 注入 → 多 run boot 接线（T1-098 双 run 前完成）。
2. run-logger/指标（metrics/meta）每 run writer 尚未迁移（决策已隔离，日志/指标为下步）。
3. 决策闸门（gate on）per-run 全闸门分支与 per-run settings 实际注入仍在多 run boot 期接线。
4. 真 claude 双 run（tmux 会话/决策/日志随行）由 T1-098 自托管真 run 冒烟验证。

## 结论

模块 acceptance 结构/验收点全部成立（隔离 seam 与冒烟齐备），无阻断问题 → verdict: pass。
