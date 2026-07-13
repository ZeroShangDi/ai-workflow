# 站点手册半自动生成流程

当用户说"生成 XX 的站点手册"时，按以下四阶段流程执行。

---

## Phase 1: AI 勘探（全自动）

### 1.1 导航到目标站点

```
browser_navigation navigate
  url: <用户提供的 URL>
  waitForLoad: true
```

### 1.2 获取页面概览

```
browser_page state    → 获取 title, URL
browser_page text     → 获取页面文本（textBudget: 3000）
browser_dom query     → 获取 DOM 结构（maxDepth: 5, maxNodes: 50）
```

### 1.3 识别可交互元素

在 DOM 结果中筛选以下标签/角色的元素：

| 标签 | 用途 |
|------|------|
| `input`, `textarea` | 输入框 |
| `button`, `[role="button"]` | 按钮 |
| `select` | 下拉框 |
| `a` | 链接/导航 |
| `[role="tab"]`, `[role="menuitem"]` | 导航组件 |
| `[role="checkbox"]`, `[role="switch"]` | 开关/选项 |

对每个元素记录：
- tag/role
- 可用的选择器（优先 `data-testid` > `id` > `aria-label` > `class` > `tag`）
- 位置和尺寸（从 bbox）
- 文本内容/标签（从 text 或 aria-label）

### 1.4 探索动态元素

对页面执行基本的交互探索：
- 点击侧边栏/菜单按钮 → 检查新出现的元素
- 悬停下拉菜单 → 检查展开的子元素
- 切换 tab → 检查切换后的内容区域

发现的动态元素标记 `dynamic: true`，记录其 `triggers`。

### 1.5 识别主要交互流

根据页面类型推断核心 flow：

| 页面类型 | 典型 Flow |
|----------|-----------|
| 聊天/AI 对话 | send_message, get_response |
| 搜索 | search, get_results |
| 表单 | fill_form, submit |
| 列表/表格 | filter, sort, select_item |
| 登录 | login |
| 设置 | update_setting |

---

## Phase 2: 生成初稿（全自动）

### 2.1 生成 YAML Frontmatter

基于勘探结果，按 `format-spec.md` 规范填充：
- 元信息（name, display_name, url, version: 1, date）
- elements 定义（每个可交互元素一个 entry，自动生成 primary + 2-3 个 fallback）
- flows 定义（每个识别出的交互流一个 entry）
- variables 定义（flow 中使用的 `$变量`）

### 2.2 生成 Markdown Body

- 页面概述（由 AI 根据页面内容总结）
- 元素汇总表
- 操作流程说明
- 注意事项（AI 根据页面特征推断）

### 2.3 写入草稿文件

```
Write: sites/_draft_<name>.md
```

### 2.4 呈现勘探摘要

向用户展示：
- 发现了多少个可交互元素
- 识别了哪些 flow
- 有哪些动态元素
- 草稿文件路径

---

## Phase 3: 人工 Review（交互式）

### 3.1 用户 Review 清单

AI 逐个询问用户确认：

1. **元素命名**：key 是否语义化？（如 `chat_input` 比 `textarea_1` 好）
2. **选择器质量**：primary 选择器是否精准？是否过于依赖可变的 class？
3. **Flow 完整性**：是否遗漏了重要的交互流？
4. **动态元素标注**：是否有未标记的动态元素？
5. **边界情况**：登录态、空状态、错误状态等

### 3.2 迭代修改

AI 根据用户反馈修改草稿，每次修改后重新呈现修改的部分。

---

## Phase 4: 保存（全自动）

### 4.1 移动文件

```
mv sites/_draft_<name>.md sites/<name>.md
```

### 4.2 终审确认

AI 读取最终文件，呈现完整手册摘要，确认无误。

### 4.3 更新元信息

确保 `version: 1`, `generated: <today>`, `last_validated: <today>`。

### 4.4 完成提示

```
站点操作手册已保存: sites/<name>.md
后续使用时，AI 将自动加载此手册，无需重复勘探。
```
