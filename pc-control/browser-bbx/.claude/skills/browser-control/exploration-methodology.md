# DOM 勘探方法论

本文件定义了在 Generate 模式中勘探未知站点时的操作规范和最佳实践。

---

## 勘探原则

### 1. 先定位 init_route

在深入勘探页面元素之前，**首先确定站点的 init_route（初始化路由）**。

**如何选择 init_route：**
- 浏览站点的主要页面，找出状态最简单、最稳定的那个
- 优先选择：空白/新建页面 > 首页 > 列表页
- 避免选择：需要特定前置条件才能到达的页面、含有大量动态内容的页面
- 记录当前 URL 的 path 部分（去掉域名），如 `/a/chat/new`

**选择理由记录：**
勘探输出中必须说明为何选择此路由作为 init_route，供后续 review 确认。

### 2. 识别站点路由结构

勘探多页面站点时，需要识别路由结构和变量：

1. 提取当前 URL 的 path 模式
2. 识别路径中的动态部分（数字 ID、slug 等），标记为 `:param`
3. 浏览不同页面，收集所有路由模式
4. 为每个路由记录其用途

示例：
```
https://github.com/anthropics/claude-code → path: /:owner/:repo
https://github.com/anthropics/claude-code/issues → path: /:owner/:repo/issues
https://github.com/anthropics/claude-code/issues/123 → path: /:owner/:repo/issues/:number
```

### 3. 逐层渐进

不要一次性抓取整个 DOM 树。按以下层级逐步深入：

1. **页面级** — `page.state` + `page.text`（1000 chars）
2. **区域级** — `dom.query` with `maxDepth: 2`，识别 header/main/sidebar/footer
3. **组件级** — 针对每个区域 `dom.query` with `maxDepth: 4`，识别表单/按钮组/列表
4. **元素级** — 对关键元素 `dom.query` with `maxDepth: 1`，确认标签、属性、位置

### 预算控制

| 阶段 | budgetPreset | maxNodes | maxDepth | textBudget |
|------|-------------|----------|----------|------------|
| 页面概览 | quick | 10 | 2 | 1000 |
| 区域扫描 | normal | 25 | 3 | 2000 |
| 精细勘探 | normal | 50 | 5 | 3000 |
| 动态探索 | deep | 30 | 4 | 2000 |

### 优先语义化属性

选择器优先级从高到低：
1. `data-testid` — 最稳定，专为测试设计
2. `id` — 通常稳定
3. `aria-label` / `aria-labelledby` — 语义化
4. `name` — 表单元素专用
5. `role` + accessible name — 无障碍属性，相对稳定
6. 唯一 `class` — 如 `.send-button--primary`（语义化 BEM 类名）
7. 通用 `class` — 如 `.ds-button`（设计系统类名，中等稳定）
8. 结构选择器 — 如 `form > div:nth-child(2) > button`（最不稳定，仅作最后 resort）

### 避免脆弱选择器

**不要**生成以下类型的选择器：
- 哈希化的 CSS Modules 类名（如 `.b13855df`）— 每次构建都可能变
- 深层嵌套的结构选择器（如 `div > div > div > span:nth-child(3)`）
- 依赖文本内容作为选择器的唯一条件（多语言下会失效）

---

## 元素分类

勘探时对每个可交互元素进行分类并标注路由作用域：

| 类别 | 特征 | 标记 |
|------|------|------|
| 静态核心元素 | 页面加载后立即存在，每次都会用到的核心交互 | `dynamic: false`, priority primary |
| 静态辅助元素 | 页面加载后存在，但不是每次都用 | `dynamic: false`, priority primary |
| 条件动态元素 | 需要特定操作后才出现（如下拉菜单、弹窗） | `dynamic: true`, 标注 `triggers` |
| 异步动态元素 | 异步加载完成后才出现（如搜索结果列表） | `dynamic: true`, `wait_for: visible` |

### 路由作用域标注

**如果元素只在特定路由页面下存在，必须标注 `route` 字段**：

```
对于每个元素：
  1. 记录发现该元素时的当前 URL path
  2. 与该站点其他路由页面对比
  3. 如果其他路由页面没有此元素 → 标注 route: <对应的 routes key>
  4. 如果所有页面都有此元素（如导航栏、全局 sidebar） → 不标注 route（全局元素）
```

**检查方法：**
- 导航到其他路由页面 → 用相同选择器查询 → 未找到 → 确认为路由限定元素
- 不确定的情况下，默认不标注 route（按全局元素处理），在 review 阶段由人工确认

---

## 交互勘探

### 安全操作

仅执行**只读或可逆**的交互：
- 悬停（hover）
- 点击展开（打开菜单/面板，但不要提交）
- 切换 tab
- 滚动

### 避免执行的操作

- 提交表单（除非明确告知用户）
- 点击「删除」「确认」「发布」等有副作用的按钮
- 修改用户数据
- 触发支付流程

### 动态元素发现

```
1. 记录页面初始状态的所有可交互元素
2. 逐个 hover/click 可展开的元素（菜单、dropdown、tooltip）
3. 每次交互后重新 query 该区域，对比新增的元素
4. 新增元素 → 标记 dynamic: true，记录触发 action
```

---

## 选择器生成策略

对每个发现的元素，生成 **1 个 primary + 2-3 个 fallback**：

```
Primary:
  优先 data-testid > id > aria-label > name

Fallback 1 (语义化):
  role + accessible name 组合查询

Fallback 2 (结构):
  唯一类名或属性选择器

Fallback 3 (JS 兜底):
  简要的 JS 定位逻辑描述（如 "唯一的 textarea 元素"）
```

示例（DeepSeek 发送按钮）：
```yaml
selectors:
  - selector: "[data-testid='send-message']"   # 如果有 testid
    type: css
    priority: primary
  - selector: "button[name='发送']"              # role + name
    type: role
    priority: fallback
  - selector: ".ds-button--primary"              # 语义化类名
    type: class
    priority: fallback
  - selector: "document.querySelector('.ds-button--primary[role=\"button\"]')"
    type: js
    priority: fallback
```

---

## 勘探输出

勘探完成后，应产出以下结构化数据：

```yaml
site_summary:
  title: "页面标题"
  url: "https://..."
  init_route: "/a/chat/new"
  init_route_reason: "新对话页面，状态最干净，无历史对话干扰"
  main_interaction_type: "chat"  # chat | search | form | browse | dashboard

routes:
  - key: chat_page
    path: "/a/chat/:id"
    description: 单个对话页面
    has_variables: true

elements_found:
  static: 8
  dynamic: 3
  global: 5       # 无 route 限定的元素
  route_scoped: 3  # 有 route 限定的元素
  total: 11

flows_identified:
  - name: send_message
    type: primary
    route: chat_page
    confidence: high
  - name: switch_model
    type: secondary
    route: chat_page
    confidence: medium

risks:
  - "发送按钮需要通过 JS click 触发，Enter 键可能无效"
  - "模型选择器在未登录状态下不可见"
```
