# W3-007 模块测试门禁 — 非真结构核查（T3-007）

> 2026-09-09 · kind=test（非真模块核查，不跑整套真实测试）
> 范围：插件层收口（T1-077…084 + 描述低强度）
> 真 run/真 claude 回归由 T1-098 承担，本门禁只做结构/验收点自检。

## 模块 acceptance → 结构证据

| 验收点 | 结构证据 | 判定 |
|---|---|---|
| awf-state 18 tools 由直连实现改薄 HTTP 代理（带 sid） | MCP 语义保留、读/写经 server（/awf/state + /run/state/apply，CC_AWF_STATE_SERVER），?sid 分片 .awf/runs/<sid>/state.json 软边界（runStamp→sid）；缺省离线直写零回归 | ✔ |
| awf-session 由直连改薄 HTTP 代理（带 sid） | 全经 server（AWF_BASE）：session_status + sid、capture 经 /status?snapshot=1（host 端口，query 修复）、intervene/interrupt/choice/ask/context-ready 走端点 | ✔ |
| awf-oneshot 由直连改薄 HTTP 代理 | env AWF_BASE → server /oneshot（oneshot adapter cc 收口，可注入），缺省本地 spawn（离线/单测） | ✔ |
| 插件注册与渲染单源化 | resolvePluginAssets（任意插件 mcp/hooks，引擎回落）、renderRepoSettings（本仓 settings 由 plugin/settings.json 渲染，第三方保留）、根 .mcp.json 消除；渲染产物与提交基线一致 | ✔ |
| 方法论资产工具无关化（低强度） | 描述扫描去运行实现字面（U5 粗略，awf-monitor-probe 归一） | ✔ |
| 全链路/冒烟 | mcp-fullchain（状态写/await/oneshot 同一 server）、two-project/sid/apply/插件集成等 82 例相关 + 全量 738 例绿（e2e 两既有基线失败除外） | ✔ |

## 遗留（不阻塞本门禁，链路已标注）

1. curl 类 hook 事件带 `&sid` 与每 run `CC_SID`/AWF_BASE 会话 env 注入 → 多 run boot 接线（T1-098 前）。
2. `/run/state/apply` 为完整 state 覆盖（last-writer-wins），并发互改缺 CAS（soft，多 run 真机前评估）。
3. 决策闸门 per-run 全分支与真 claude 双 run 由 T1-098 验证。
4. per-plugin 自身 mcp/hooks 暂无实际插件声明（接缝已锁测试）。

## 结论

模块 acceptance 结构/验收点全部成立（插件收口 + 单源渲染 + 全链路冒烟），无阻断 → verdict: pass。
