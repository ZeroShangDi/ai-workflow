# Mock 开发模式

运行 `npm --prefix web run dev:mock -- --host 127.0.0.1`，打开 http://127.0.0.1:5174/ 。该模式禁用 Vite API 代理；请求进入内存 server，未知接口返回 404，不回退真实服务。普通开发模式也可用 `?mock=1` 显式启用；生产构建不会包含 mock。

## 文件职责

- `fixtures.js`：与当前前端消费的 server 字段匹配的模拟数据。
- `server.js`：纯内存接口与状态流转，可在 Node 中独立测试。
- `browser.js`：模拟 HTTP 延迟、取消、WebSocket 订阅，每 3 秒推进一次状态；通过 transport 注入，不修改全局 fetch。
- `src/app/components/PreviewControls.jsx`：开发控制条。切场景或重置会刷新，清空本次模拟修改。主题可以切换；浅色仅用于检验换肤入口。

## 场景

| 参数 scenario | 用途 |
| --- | --- |
| demo | 运行中，有任务、决策、提案、事件及会话输出 |
| idle | 有待执行任务，可从界面启动 Run |
| empty | 无任务、运行、决策或提案 |
| waiting | 暂停且等待用户选择/输入 |
| conflict | 审批记录成功但变更冲突，验证提示区别 |
| error | status 可读，其余接口返回 503 |

第二个项目始终为空，用于项目切换和状态隔离检查。mock 数据只在当前浏览器页面内存中，刷新恢复。推进按钮与定时器模拟输出和任务状态，不执行 Claude、命令或真实任务，不实现持久化、完整任务图验证或业务引擎。

## 覆盖接口

GET：`/status`（含 snapshot）、`/awf/state`、`/run/status`、`/run/events`（游标/数量/Run 筛选）、`/awf/decisions`、`/awf/dynamic-planning/proposals`、`/awf/metrics`、`/awf/diagnostics`。

POST：`/run/submit`、`/run/state/mode`、`/send`、`/respond`、`/stop`、`/awf/diagnostics`、`/awf/decisions/:id/override`、`/awf/decisions/:id/resolve`、`/run/dynamic-planning/proposals/:id/approve`。

覆盖当前 `shared/api` 全部地址及当前页面使用的操作。不是整个 server 的替代实现；未接入本期 UI 的操作（如新增后端能力）不在 mock 中凭空实现。新增 UI 请求时同时增加 mock handler、fixture 和状态变化测试。

## 验证

`npm --prefix web test`

mock 服务运行时，用 `PLAYWRIGHT_MODULE=/absolute/path/to/playwright node web/tests/browser.cjs` 执行真实浏览器验证；若已安装 Playwright，可省略变量。`CHROME_PATH` 可指定本机 Chrome 路径。
