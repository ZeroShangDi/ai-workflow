# 可操作的 Mock 工作空间

启动：`npm --prefix web run dev:mock -- --host 127.0.0.1`。

- 从头体验：http://127.0.0.1:5174/?scenario=empty&view=project
- Plan：http://127.0.0.1:5174/?scenario=plan-ready&view=plan
- 运行：http://127.0.0.1:5174/?scenario=demo&view=run
- 冲突恢复：http://127.0.0.1:5174/?scenario=conflict&view=reviews

所有模拟数据、状态机、延时、真实日志样本、预览控制与 mock 测试均在本文件夹。`src/` 中只有正式页面和接口消费逻辑；唯一开发引导在 `src/main.jsx`，生产构建不会包含本文件夹。新增接口和字段见 [CONTRACT.md](./CONTRACT.md)，类型定义见 [contract.ts](./contract.ts)。

## 按时间轴验收

1. **空工作空间**：添加项目 → 目录列表加载 → 选择目录 → 打开。取消对话框不改变项目。
2. **读取环境**：`new-product` 为新项目；`cc-work` 恢复已有任务和决策；`unreadable` 首次读取失败，可点击重试读取恢复。目录均为内存样本，不访问本机目录。
3. **新增需求**：环境就绪后填写需求，提交后出现在需求记录中。空输入禁止提交。
4. **Plan**：生成 → 生成中 → 草稿。编辑摘要/任务标题 → 保存 → 确认计划 → 启动 Run。失败场景可重试，未保存草稿不能确认。
5. **Run**：结构化会话、当前输出、项目真实日志三种视图；发送、等待选项/文本回复、打断回复、暂停/恢复调度、取消/重试运行。
6. **决策/动态复审**：新需求的运行完成第一个任务时会产生实际关联的动态提案与决策，并暂停。批准后插入验证任务并更新依赖；也可以提供其他方案。任务、决策、提案、会话、日志共用同一状态。
7. **收尾**：任务按依赖执行，全部完成后 Run 完成。已完成任务不会再重跑；失败或取消保留运行历史，重试产生新 Run。
8. **日志**：Run 筛选、搜索、清屏、跟随；当前输出搜索。历史真实日志不随 mock 改写。

## 场景控制

| 场景 | 状态 |
|---|---|
| empty | 无项目、无任务 |
| directory | 环境读取中 |
| environment | 环境已就绪，无需求 |
| requirement | 已新增需求，待规划 |
| planning / plan-ready / plan-error | 生成中 / 待确认 / 生成失败 |
| queued | 排队中，下一拍启动 |
| idle | 恢复已有任务，待启动 |
| demo | 执行中，含多种任务与复审记录 |
| waiting / waiting-text | 等待选项 / 等待自由输入 |
| blocked / failed | 任务阻塞 / 运行失败 |
| completed / cancelled | 已完成 / 已取消 |
| conflict | 首次审批冲突；重新校验后可再次批准 |
| error | status 可读，其余接口 503；点击恢复接口后可重试 |

控制条支持切场景、重置、主题、暂停自动推进和逐拍推进。刷新重置当前内存；切场景同时清除旧项目/Run URL 参数。空项目场景从真正的空项目列表开始，其他场景含两个隔离项目。

## 文件

- `fixtures.js`：场景与数据。
- `server.js`：现有接口、事件游标、Run 调度、项目隔离。
- `lifecycle.js`：目录后续流程、Plan、Run 恢复、决策/提案动作。
- `browser.js`：transport、HTTP 延时/取消、事件订阅、时钟。
- `PreviewControls.jsx`、`preview.css`：仅开发期场景控制。
- `logs/project-log.js`：本仓 `.awf/decisions/runs/0.2.0-2026-09-10T14-21-09.jsonl` 原文静态快照。是真实决策日志，不是完整聊天转录；structured 会话是独立的界面示例。
- `tests/`：兼容测试、时间轴/边界测试、浏览器交互验收。

## 验证

`npm --prefix web test` · `npm --prefix web run lint` · `npm --prefix web run build`

浏览器：启动 mock 服务后，执行 `PLAYWRIGHT_MODULE=/absolute/path/to/playwright node web/mock/tests/browser.cjs`。`CHROME_PATH` 可指定 Chrome。验证会检查页面异常、移动端横向溢出、完整流程与零真实 API 网络请求。
