# 调试排查

针对指定的 bug 或异常现象进行系统化排查。

## 参数

`$ARGUMENTS` — 问题描述（如 `侧边栏消息列表不滚动到底部`、`Agent 任务执行后无反馈`、`划词弹窗在 GitHub 上不显示`）

## 前置 Skill 调用

自动调用 `superpowers:systematic-debugging` skill — 系统化排查，避免盲目修改。

## 执行流程

1. **系统化调试**（调用 `superpowers:systematic-debugging`）：建立假设、收集证据、验证排除
2. **复现理解**：根据 `$ARGUMENTS` 理解问题表现和触发条件
2. **定位入口**：确定问题涉及的功能模块和代码入口点
3. **追踪链路**：从入口开始，沿数据流 / 事件链逐步追踪：
   - 用户操作 → Vue 组件 → Store → Background → API
   - 注意跨上下文通信：content script ↔ background ↔ sidepanel
   - 检查 SSE 事件处理（event 100/200/300 等各分支）
4. **缩小范围**：
   - 检查条件分支是否命中了预期路径
   - 检查异步操作的时序（race condition）
   - 检查浏览器扩展 API 调用的参数和返回值
   - 检查 DOM / Shadow DOM 边界问题（content script 场景）
5. **定位根因**：找到 bug 的具体代码位置和原因
6. **提出修复方案**：
   - 给出具体的代码修改建议
   - 说明修复是否有副作用
   - 如有多种修复方式，对比优劣

## 常见排查方向

| 问题类型 | 排查方向 |
|---------|---------|
| 消息不显示/丢失 | SSE 事件处理、store 更新、MessageList 渲染 |
| Agent 任务异常 | event=300 处理、WebSocket 连接、actions 执行 |
| 划词/图片功能异常 | content script 注入、Shadow DOM 隔离、黑名单域名 |
| 样式异常 | UnoCSS 类名、Shadow DOM 样式隔离、Element Plus 主题变量 |
| 性能问题 | 组件重渲染、store 响应式粒度、大列表未虚拟滚动 |
| 多标签页冲突 | tabId 隔离、store 实例混用 |

## 注意

- 先分析后修复，不要一上来就改代码
- 修复后运行 `pnpm lint` 和 `pnpm typecheck` 验证
