# 实效检测协议

每次 Execute 模式启动时，必须先对站点手册进行实效检测，确保选择器没有过期。

---

## 检测级别

| 级别 | 条件 | 行为 |
|------|------|------|
| 绿色 | 当前路由范围内的所有 static 元素 primary selector 命中 | 直接继续执行 |
| 黄色 | 部分 primary 失效，fallback 命中 | 自动切换 selector，提示用户"建议更新手册"，继续执行 |
| 红色 | 有元素全部 selector 未命中 | 阻止执行，提示用户重新生成手册 |

---

## 检测流程

### 1. 导航到 init_route

```
解析手册中的 init_route（如有路由变量 :param，替换为运行时值）
构造完整 URL: <url> + <init_route>
browser_navigation navigate
  url: <完整 URL>
  waitForLoad: true
  timeoutMs: 15000
```

使用已有的标签页（`browser_tabs list` → 找匹配的 origin）。

**为什么是 init_route 而不是根 URL？**
- init_route 是状态最稳定、最简单的页面
- 避免在复杂页面上进行检测（可能有弹窗、异步加载、动态内容干扰）
- 确保检测环境和实际控制环境一致

### 2. 收集待检测选择器（路由过滤）

从手册 `elements` 中筛选需要检查的元素：

```
current_route = <当前 init_route 的 path>

for e in elements:
  if e.dynamic == true:
    SKIP                           # 动态元素不检测
  if e.route is defined AND e.route != current_route:
    SKIP                           # 元素绑定到其他路由，当前页面不可见
  if e.route is NOT defined:
    INCLUDE                         # 全局元素，所有页面检查
  if e.route == current_route:
    INCLUDE                         # 当前路由下的元素

static_elements = <筛选结果>
primary_checks = {e.name: e.selectors[0] for e in static_elements}
fallback_map   = {e.name: e.selectors[1:] for e in static_elements}
```

### 3. 批量检测 Primary Selectors

使用 `browser_batch` 一次性查询所有 primary selector：

```
browser_batch(calls=[
  {method: "dom.query", params: {selector: primary_checks[e1].selector, maxNodes: 1}},
  {method: "dom.query", params: {selector: primary_checks[e2].selector, maxNodes: 1}},
  ...
])
```

每个结果判定：
- 返回 ≥1 元素 → VALID
- 返回 0 元素 → 进入 fallback 检测

### 4. Fallback 检测（仅对 primary 失效的元素）

对每个 primary 失效的元素，逐个尝试 fallback selector：

```
for element in primary_failed:
  for fallback in fallback_map[element]:
    result = browser_dom query(selector=fallback.selector, maxNodes=1)
    if result matches:
      → STALE (记录 fallback_used)
      → 本次会话将 fallback 提升为主 selector
      break
  if no fallback matched:
    → MISSING
```

### 5. JS 兜底

如果 primary 和所有 fallback 都失效，尝试用 `page.evaluate` 执行一个通用的 DOM 查找：

```
page.evaluate("document.querySelector('...').tagName")
```

这在 CSS class 变了但 DOM 结构没变时能救回来。

### 6. 输出报告

```
实效检测报告 — DeepSeek Chat (v1, 2026-07-01)
路由: /a/chat/new (init_route)
─────────────────────────────────────────────
✅ chat_input       VALID      (primary: textarea)
✅ send_button      VALID      (primary: .ds-button--primary)
⚠️  model_selector   STALE      (使用 fallback: role:button[name='模型'])
❌ history_panel    MISSING    (全部 3 个选择器均未命中)
—  dynamic elements skipped: 2 (response_markdown, ... )
—  route-scoped skipped: 1 (close_issue_button → issue_detail)
─────────────────────────────────────────────
结果: 🟡 黄色 — 3/4 通过，使用 1 个备用选择器
```

### 7. 更新手册

- 绿色 → 仅更新 `last_validated: <today>`
- 黄色 → 更新 `last_validated`，可选地交换 primary/fallback 后递增 `version`
- 红色 → 不更新，提示用户重新生成

---

## 路由切换时的增量检测

当 flow 执行过程中需要导航到其他路由（如 flow 绑定到 `issue_detail`），在导航后**增量检查**该路由对应的元素：

```
1. 导航到目标路由
2. 筛选出该路由限定的元素（route == target_route）
3. 仅检查这些元素的 primary selector
4. 通过 → 继续执行 flow
5. 失败 → 尝试 fallback，仍失败则报告并停止
```

---

## 性能优化

- 使用 `budgetPreset: quick`（maxNodes=1, maxDepth=1）降低 token 消耗
- 所有 primary selector 用 `browser_batch` 一次查询
- 不使用 screenshot（实效检测不需要视觉确认）
- 结果缓存到会话内存，整个会话期间不重复检测
- 路由过滤减少无效检查：只检查当前页面实际存在的元素
