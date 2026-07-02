# UI 设计稿生成

设计稿的全生命周期管理：创建/推送设计稿到 Figma，或选择 UI 风格后生成设计。

## 参数

`$ARGUMENTS` — 设计任务描述或 Figma URL。例如：
- `侧边栏布局推送到 Figma` — 代码 → Figma
- `https://figma.com/design/xxx?node-id=1-2` — Figma → 代码
- `为 InputBox 组件选风格`

## 与 w-ui 的边界

- **w-design**：设计稿的全生命周期管理。双向（代码↔Figma）、新建文件、设计系统/组件库生成、设计 token 管理、**风格选择**。用于「产出设计稿」本身。
- **w-ui**：Figma 设计稿 → 代码的精确视觉还原。用于「照着设计稿写样式」。输入必须是含 `node-id` 的 Figma URL。

如果只是拿到一个 Figma 链接要还原 UI → `/w-ui`。如果要创建/管理设计稿本身或选择风格 → `/w-design`。两者需要 Figma 操作时都必须加载 `/figma-use` skill。

## 执行流程

### 新建设计 / 风格选择（无 Figma URL）

#### 步骤 1：读取用户偏好

检查 `.claude/user/style-preferences.md`，如果有历史偏好则作为默认推荐。

#### 步骤 2：生成 3 种风格方案

根据任务描述，生成 3 种不同的 UI 风格方案供选择。每种方案描述：

```
## 风格 A：[名称]
- **配色**：[主色调、辅助色、背景色]
- **布局**：[布局策略、间距密度]
- **组件风格**：[圆角、阴影、边框风格]
- **字体**：[字号层级、字重偏好]
- **适合场景**：[简要说明]
```

三种风格应有显著差异（如：现代极简 vs 传统稳重 vs 活泼鲜艳）。

#### 步骤 3：用户选择

使用 `AskUserQuestion` 展示 3 种风格，等待用户选择。

#### 步骤 4：保存偏好

将选中风格写入 `.claude/user/style-preferences.md`，作为后续 UI 生成的默认偏好。

#### 步骤 5：逐步生成 UI

根据原型（来自 w-plan 产出），**逐步**生成各页面/组件的 UI 设计，不要一次性生成所有 UI。每生成一个页面/组件后暂停确认。

### 代码 → Figma

1. 阅读 `$ARGUMENTS` 指定的组件/页面源码，理解结构和样式
2. 加载 `/figma-use` skill
3. 如果是完整页面/视图，同时加载 `/figma-generate-design` skill
4. 如果是组件库/设计系统，同时加载 `/figma-generate-library` skill
5. 使用 Figma MCP 工具将设计写入 Figma 文件

### Figma → 代码

1. 从 URL 提取 fileKey 和 nodeId
2. 使用 `get_design_context` 获取设计上下文和截图
3. 根据设计稿生成 Vue 3 + TypeScript 代码
4. 使用 Element Plus 组件和 UnoCSS 样式

### 创建新 Figma 文件

1. 加载 `/figma-create-new-file` skill
2. 创建 Figma 文件
3. 使用 `/figma-use` 和相关 skill 构建设计

## 注意

- Figma 操作前必须加载对应的 skill（figma-use 是强制前置）
- 风格选择流程在 awf-run 的 DESIGN 阶段自动触发
- 用户偏好保存在 `.claude/user/` 下，跨会话持久化
