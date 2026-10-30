# MCP 读响应未设 utf8：state 变大后每次写都被 CAS 判为冲突

- 状态: fixed（2026-09-12，T3-010-F1 收尾时暴露）
- 类型: awf 产品缺陷（插件 MCP 传输层 / 单写者 CAS）
- 严重度: high（运行期无法落账，且随 state 体积增长必然发生）
- 关联: `plugin/core/mcp/awf-state/server.cjs`、`plugin/core/mcp/awf-session/server.cjs`、`plugin/core/mcp/awf-oneshot/server.cjs`、T1-077（单写者 CAS）、`src/lib/state.js`（`stateFingerprint`）

## 现象

`awf run` 运行到 T3-010-F1 收尾时，AI 调 `awf_task_complete` **连续失败**：

```json
{ "ok": false, "error": "state 已被其他写者更新，请重新读取后重试" }
```

重读、重试均无效；同一时刻 `.awf/state.json` 的 mtime 与 size 完全静止（没有任何并发写者）。

## 复现

```bash
# 同一份 state 分别用两种解码方式读，比较指纹
curl -s "http://127.0.0.1:8787/awf/state?p=$ROOT" | sha256   # 正确（shell/curl 解码）
# vs. 逐块 Buffer 拼接（MCP 的做法）→ 指纹不同，且含 U+FFFD
```

实测（`state.json` 356,857 字节）：正确解码的指纹 `73d73d19…` 与磁盘一致；逐块拼接的指纹 `c3f5bd05…` 不一致，文本中出现 **399 个 U+FFFD**。

## 根因

`plugin/core/mcp/awf-state/server.cjs` 的 `httpJson()`：

```js
r.on('data', (c) => { raw += c; });   // 未 setEncoding('utf8')
```

不设编码时 `data` 给的是 `Buffer`，`raw += c` 会对**每个 chunk 各自** `toString()`。UTF-8 是变长编码，一个汉字/全角符号的 3 个字节一旦跨 chunk 边界，两半分别解码即各变成一个 U+FFFD。

于是链路变成：

```
MCP 读 state（HTTP，被切碎） → serverState 指纹 ≠ 磁盘指纹
  → POST /run/state/apply 带 expectedStateFingerprint（错的值）
  → server 的 replaceStateIfUnchanged 比对失败 → 409 conflict
```

**为什么现在才炸**：state.json 是中文密集的（任务标题/验收/result 全是中文），但早期体积小、chunk 少，命中边界的概率低。随 run 累积到几十万字节，chunk 数变多，必然命中——**体积过阈值后 100% 复现**。读路径不受影响（只是拿到被切碎的文本），所以此前表现为「读得到、写不进」这种不易归因的形态。

## 影响面

同一写法在三个插件 MCP 里都有，不止 awf-state：

| 文件 | 位置 | 后果 |
|---|---|---|
| `awf-state/server.cjs` | `httpJson` 响应 | **写必失败（409）** —— 单写者 CAS 把「读脏」放大成「写全断」 |
| `awf-session/server.cjs` | `httpPost` / `httpGet` | `capture_pane` 等大中文响应出现乱码；跨边界的 JSON 可能解析失败 |
| `awf-oneshot/server.cjs` | `httpJson` 响应 + `claude -p` stdout 的 `c.toString()` | LLM 输出乱码；同样按 chunk 单独解码 |

## 修复

共 5 处补显式 utf8（流式 + 子进程 stdout 一并覆盖）：

- `awf-state/server.cjs` `httpJson`：`r.setEncoding('utf8')`
- `awf-session/server.cjs` `httpPost` / `httpGet`：`res.setEncoding('utf8')`
- `awf-oneshot/server.cjs` `httpJson`：`r.setEncoding('utf8')`；`runOneShot`：`proc.stdout.setEncoding('utf8')`

验证：修复前正确/错误两种解码的指纹分别为 `73d73d19…`（=磁盘）与 `c3f5bd05…`；修复后 MCP 读到的与磁盘一致。

## 坑：MCP 进程不热加载

修复落在磁盘后，**当前会话里已 spawn 的 MCP 进程仍跑旧代码**，所以当场重试依旧 409。要让修复生效需重连 MCP（重启会话 / `/mcp` 重连）。

本次收尾因此改经 server 单写者端点 `POST /run/state/apply` 提交，且**带正确的 CAS 令牌**（由本地正确解码的 state 计算）—— 走的是同一权威路径与同一并发保护，不是绕过单写者。这一步是权宜，不是常规做法：常规路径仍是 `awf_task_complete`。

## 关联

- 若后续给 state 增加「体积告警」或「MCP 写失败自检」，本缺陷是动机之一：**读路径的静默退化被写路径的 CAS 放大成了硬失败**，属于典型的「单写者守卫把一个输入侧 bug 变成全停」。同类风险点应一并扫查（所有 `on('data', … += …)` 形态）。
