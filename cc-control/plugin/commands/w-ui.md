# UI 还原

从 Figma 设计稿读取设计信息，在项目中实现对应的 UI 样式和结构。

## 参数

`$ARGUMENTS` — Figma URL + 可选的补充描述。格式：

```
<figma-url> [补充说明]
```

示例：
- `https://figma.com/design/xxx/file?node-id=1-2`
- `https://figma.com/design/xxx/file?node-id=1-2 实现为 InputBox 的新样式`
- `https://figma.com/design/xxx/file?node-id=3-4 只还原颜色和间距，布局保持现有`

## 前置 Skill 调用

自动加载 `/figma-use` skill（Figma MCP 调用的强制前置）。

## 与 w-design 的边界

- **w-ui**：Figma URL → 精确视觉还原代码。输入必须是含 `node-id` 的 Figma URL，输出是对应的 Vue 组件代码。
- **w-design**：设计稿全生命周期管理（双向、新建文件、设计系统、token 管理）。

如果你的需求是「这个 Figma 设计稿，帮我在项目里实现出来」→ `/w-ui`。如果是「帮我把这个组件推到 Figma」或「帮我新建一个设计稿」→ `/w-design`。

## 执行流程

1. **解析参数**：从 `$ARGUMENTS` 中提取 Figma URL（fileKey + nodeId）和补充描述
2. **读取设计稿**：调用 `get_design_context` 获取：
   - 设计上下文代码（布局、颜色、字体、间距等）
   - 截图（作为视觉参照）
   - 设计 token / 变量信息
3. **定位目标文件**：
   - 根据补充描述确定要修改的组件/页面
   - 如未指定，根据设计稿内容匹配项目中最相关的文件
4. **分析差异**：对比设计稿与现有代码的视觉差异
5. **实施还原**：
   - 优先使用 UnoCSS 原子类
   - Element Plus 组件样式通过 `:deep()` 或 CSS 变量覆盖
   - 颜色值优先使用项目已有的 CSS 变量 / UnoCSS 主题值
   - Shadow DOM 场景注意样式隔离边界
   - 间距、圆角、字号等尽量对齐设计稿的精确数值
   - 布局使用 flex/grid，还原设计稿的对齐和间距关系
6. **验证**：
   - `pnpm lint` 检查代码规范
   - 确认改动不影响其他组件

## 样式优先级

1. UnoCSS 原子类 — 常规布局、间距、颜色
2. Element Plus CSS 变量 — 组件库定制
3. Scoped Sass — 组件特有的复杂样式
4. 全局样式 — 仅限于基础重置和通用工具类

## 注意

- Figma URL 必须包含 `node-id` 参数，否则提示用户提供具体节点的链接
- 设计稿中的图片/图标资源，使用 `download_assets` 下载后放入项目对应目录
- 如果设计稿使用了组件库中的组件，优先查看是否有对应的 Element Plus 组件可复用
- 不要为了还原设计稿而引入不必要的 DOM 嵌套
