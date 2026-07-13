# Tier 2 站点操作手册格式规范

每个站点手册是一个独立的 `.md` 文件，存放于 `sites/<name>.md`。

由两部分组成：
- **YAML frontmatter**：结构化数据，AI 直接解析使用
- **Markdown body**：人类可读的站点说明

---

## YAML Frontmatter 字段定义

### 元信息

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 站点短标识，用作文件名。仅含小写字母、数字、连字符。如 `deepseek`、`github` |
| `display_name` | string | 是 | 人类可读的站点名称。如 `DeepSeek Chat` |
| `description` | string | 是 | 站点用途和支持的交互概述。AI 用此判断用户意图是否匹配此站点 |
| `url` | string | 是 | 站点域名根地址。如 `https://chat.deepseek.com` |
| `init_route` | string | 是 | **初始化路由**，用于出错重置和每次控制前的环境初始化。必须指向站点中状态最稳定的页面 |
| `version` | integer | 是 | 手册版本号，每次更新递增 |
| `generated` | date | 是 | 生成/更新日期，格式 `YYYY-MM-DD` |
| `last_validated` | date | 是 | 最近一次实效检测通过的日期 |

### init_route 说明

`init_route` 是整个站点手册的「锚点」——每次开始操控站点前，先导航到此路由以确保环境干净。

**用途：**
- **出错重置**：执行过程中发生异常，导航回 `init_route` 重置状态后重试
- **控制前初始化**：每次 Execute 模式启动时，先导航到 `init_route`，再进行实效检测
- **状态恢复**：操作导致页面状态异常（弹窗遮挡、导航迷路）时，回到 `init_route` 恢复

**选择原则：**
- 选择站点中状态最简单、最稳定的页面
- 通常是首页、列表页、或新建/空白页面
- 避免选择需要特定前置条件才能到达的页面

**示例：**
```yaml
# DeepSeek — 新建对话页（状态最简单，没有历史对话干扰）
init_route: /a/chat/new

# GitHub — 仓库首页（稳定加载，不需要特定参数）
init_route: /:owner/:repo

# 后台管理系统 — 仪表盘首页
init_route: /dashboard
```

注意：`init_route` 中也可以包含路由变量（`:owner`, `:repo`），使用时需要绑定运行时值。

### routes（可选）

多页面站点的路由定义。每个路由有一个 key 和以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 路由路径，支持 `:param` 变量占位。如 `/user/:id/settings` |
| `description` | string | 是 | 该路由页面的用途 |
| `triggers_on` | array | 否 | 进入该路由的前置条件，如 `[auth_required]` |

路由变量可用 `$` 前缀引用，如 `$id` 映射到 `:id`。

```yaml
routes:
  repo_home:
    path: "/:owner/:repo"
    description: 仓库首页

  repo_issues:
    path: "/:owner/:repo/issues"
    description: Issue 列表页

  issue_detail:
    path: "/:owner/:repo/issues/:number"
    description: 单个 Issue 详情页
```

### elements

页面可交互元素的定义。每个元素有一个 key（语义化名称）和以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 是 | 中文描述元素用途 |
| `route` | string | 否 | **路由作用域**，元素仅在指定路由页面下存在。值为 routes 中定义的 key，或被省略表示全局（所有页面存在） |
| `selectors` | array | 是 | 选择器列表，按优先级排列 |
| `selectors[].selector` | string | 是 | 选择器表达式 |
| `selectors[].type` | enum | 是 | 见下方选择器类型表 |
| `selectors[].priority` | enum | 是 | `primary` / `fallback` |
| `wait_for` | enum | 否 | 交互前等待条件：`visible` / `hidden` / `attached` / `none` |
| `dynamic` | boolean | 否 | 是否动态加载，默认 `false` |
| `triggers` | array | 否 | dynamic=true 时，触发该元素出现的条件（action 名或描述） |
| `wait_after_action` | integer | 否 | 交互后等待毫秒数 |

### 路由作用域说明

`route` 字段将元素绑定到特定路由页面。这解决了一个关键问题：**有些按钮只在特定路由菜单下才有**。

**行为规则：**
- 元素无 `route` 字段 → 全局元素，任何页面都会检查
- 元素有 `route` 字段 → 实效检测时，仅当当前页面匹配该路由时才检查此元素
- flow 执行时，如果操作的目标元素有路由限定，AI 需要先导航到对应路由

**示例：**
```yaml
elements:
  # 全局元素 — 所有页面都存在
  site_logo:
    description: 站点 logo
    selectors:
      - selector: ".navbar-logo"
        type: css
        priority: primary

  # 路由限定元素 — 只在 Issue 详情页存在
  close_issue_button:
    description: 关闭 Issue 的按钮
    route: issue_detail                                      # 绑定到 issue_detail 路由
    selectors:
      - selector: "button[name='Close issue']"
        type: role
        priority: primary
```

### 选择器类型

| type | 说明 | 示例 | 对应 BBX 方法 |
|------|------|------|--------------|
| `css` | CSS 选择器 | `"textarea"`、`"[data-testid='send']"` | `dom.query` |
| `class` | CSS 类选择器（自动加 `.`） | `"ds-button--primary"` | `dom.query` |
| `role` | ARIA 角色 + accessible name | `"button[name='发送']"` | `dom.find_role` |
| `text` | 包含指定文本的元素 | `"发送消息"` | `dom.find_text` |
| `js` | 自定义 JS 定位（兜底） | `"document.querySelector('textarea')"` | `page.evaluate` |

### flows

操作流程定义。每个 flow 有一个 key 和以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 是 | 中文描述该 flow 的用途 |
| `route` | string | 否 | 该 flow 绑定的路由。执行前 AI 会先导航到此路由 |
| `steps` | array | 是 | 步骤列表 |
| `preconditions` | array | 否 | 前置条件描述列表 |

### 步骤类型

| action | 用途 | 关键参数 |
|--------|------|----------|
| `navigate` | 导航到 URL | `url`（支持 `$变量` 和路由 pattern）, `waitForLoad` |
| `type` | 输入文本 | `target` (元素 key), `value`, `clear`, `submit` |
| `click` | 点击元素 | `target` (元素 key) |
| `wait` | 等待条件 | `condition` (element_visible / time), `target`, `timeoutMs` |
| `read_text` | 提取文本 | `target` (元素 key) |
| `scroll` | 滚动到元素 | `target` |
| `press_key` | 按键 | `target`, `key` |
| `hover` | 悬停 | `target` |
| `select_option` | 选择下拉 | `target`, `values`/`labels` |
| `evaluate` | 执行 JS | `expression` |

`$变量名` 语法表示运行时参数。

### variables

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 是 | 变量用途说明 |
| `required` | boolean | 是 | 是否必填 |
| `default` | any | 否 | 默认值 |
| `example` | string | 否 | 示例值 |

变量分为两种：
- **Flow 运行时变量**：如 `$message`、`$query`，由用户指令提取
- **路由变量**：如 `$owner`、`$repo`，用于填充 `path` 中的 `:param` 占位符

---

## Markdown Body 规范

Body 部分是给人类阅读的，不强制格式，但建议包含：

1. **页面概述**：一句话描述站点用途和主要交互区域
2. **初始化路由**：说明 `init_route` 选择原因
3. **路由表**：列出所有路由及其用途
4. **元素汇总表**：以表格形式列出所有元素，标注路由作用域
5. **操作流程说明**：每个 flow 的用途、参数、预期结果
6. **注意事项**：登录要求、反爬特征、超时建议、已知问题
7. **变更记录**：版本号 + 日期 + 变更内容
