# 开发执行

根据任务描述进行功能开发或代码修改。

## 参数

`$ARGUMENTS` — 开发任务描述（如 `实现划词翻译功能`、`InputBox 增加语音输入按钮`）

## 前置 Skill 调用

根据任务性质自动调用：
- **brainstorming** — 涉及新功能或行为修改时先探索方案
- **test-driven-development** — 有明确可测逻辑时先写测试
- **verification-before-completion** — 完成后验证改动正确性

## 关联 Skill

以下 skill 在开发过程中持续生效，无需显式调用：

- **code-standards** — 函数设计、命名规范、错误处理、代码风格等微观编码标准。写任何代码时都应遵循。
- **design-standards** — 组件架构、数据建模、状态管理、设计模式等宏观设计标准。新增 store / composable / 模块时务必查阅。

## 执行流程

1. **理解任务**：分析 `$ARGUMENTS`，明确要做什么
2. **方案探索**（如需）：调用 `superpowers:brainstorming` 探索方案
3. **定位代码**：找到需要修改/新增的文件，阅读相关代码理解现有逻辑
4. **检查依赖**：确认是否需要新增依赖包、是否有可复用的现有组件/工具
5. **实施开发**：
   - 遵循项目现有的代码风格和架构模式
   - Vue 3 Composition API + TypeScript
   - 使用 Element Plus 组件库和 UnoCSS 原子化样式
   - Store 按 tabId 隔离的多会话模式
   - 背景脚本中的模块用 `.js`，其余用 `.ts` / `.vue`
6. **代码检查**：完成后运行 `pnpm lint` 和 `pnpm typecheck` 确保无报错
7. **验证**（调用 `superpowers:verification-before-completion` skill）：确认改动生效
8. **总结变更**：输出修改了哪些文件、做了什么改动

## 开发规范

- 不擅自添加打点/埋点代码
- 不擅自引入新的第三方依赖（需确认）
- 消息通信遵循项目已有的 `webext-bridge` + `chrome.runtime.sendMessage` 模式
- 新增组件放在对应功能目录下，公共组件放 `src/components/`
- 路径别名使用 `~/` 映射 `src/`
