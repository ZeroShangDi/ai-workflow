---
name: browser-control
description: >
  浏览器自动化控制标准。定义站点操作手册格式、DOM 探索方法、
  元素选择交互模式、会话前实效检测机制、以及 Tier 2 站点手册的半自动生成流程。
  触发：浏览器控制、browser control、生成站点手册、操控网站、打开XX网站、自动操作XX、
  给XX发送、检测XX站点、生成XX手册
---

# 浏览器自动化控制标准

本 skill 提供一套标准的浏览器自动化流程，核心思路是**把每次都要重新摸索的 DOM 勘探变成一次性的、可复用的站点说明书**。

## 三种工作模式

### 1. Execute 模式 — 执行站点操作

用户说"帮我在 DeepSeek 上发消息"、"给 GitHub 点个 star"等时触发。

流程：
```
发现站点名 → 加载 sites/<name>.md → 导航到 init_route 初始化环境 → 实效检测（必须）→ 执行 flow → 返回结果
                                    ↑
                              出错时回到 init_route 恢复状态后重试
```

### 2. Generate 模式 — 生成站点手册

用户说"生成 XX 的站点手册"、"create browser manual for XX"时触发。

流程：
```
导航到站点 → DOM 勘探 → 识别元素和交互流 → 生成初稿 → 人工 review → 保存
```
详见 `generation-workflow.md`。

### 3. Validate 模式 — 仅检测手册是否有效

用户说"检测 XX 站点"、"validate site XX"时触发。

流程：
```
加载手册 → 批量验证选择器 → 输出状态报告
```
详见 `validity-checking.md`。

## 站点发现机制

1. 从用户指令中提取站点标识（域名、站点名、别名）
2. 检查 `sites/` 目录下是否存在对应的 `<name>.md` 文件
3. 匹配规则：`name` 字段（frontmatter）完全匹配，或文件名（不含 `.md`）完全匹配
4. 未找到 → 提示用户是否需要 Generate 模式生成
5. 找到 → 进入 Execute 模式

## 核心规则（不可跳过）

- **初始化路由先行**：每次 Execute 模式启动时，必须先导航到站点手册定义的 `init_route`，确保环境干净，再进行实效检测
- **出错回退到 init_route**：flow 执行过程中发生异常，导航回 `init_route` 重置状态，然后重试（最多重试 1 次）
- **实效检测前置**：init_route 初始化完成后立即运行实效检测，检测通过才能执行操作
- **路由限定检测**：实效检测只检查当前路由页面存在的元素（`route` 字段匹配或无 `route` 限定）
- **批量优先**：实效检测使用 `browser_batch` 一次性检查多个选择器，减少往返
- **选择器降级**：主选择器失效时自动尝试 fallback，仍失败则阻止执行并提示用户重新生成
- **动态元素延迟检测**：`dynamic: true` 的元素不在实效检测阶段检查，在实际交互前通过 `wait` 步骤定位
- **每步验证**：flow 中的每个 step 执行后验证结果，失败时报告具体步骤和原因
- **优先复用现有浏览器标签页**，避免反复打开新标签

## 执行步骤（Execute 模式详细）

### Step 0: 环境初始化（init_route）
- 获取站点手册中的 `init_route`
- 构造完整 URL：`<url> + <init_route>`，如有路由变量（`:param`）则替换为运行时值
- 导航到 init_route
- 等待页面加载完成
- 如果 init_route 导航失败 → 降级导航到根 `url`

### Step 1: 加载站点手册
- 读取 `sites/<name>.md`
- 解析 YAML frontmatter 获取 init_route、elements、flows、variables、routes
- 确定目标 flow，检查其 `route` 绑定

### Step 2: 实效检测
- 按 `validity-checking.md` 协议执行
- **仅检查当前路由页面范围内的元素**（元素 `route` 字段匹配当前路由，或无 `route` 字段的全局元素）
- 通过（绿色/黄色）→ 继续
- 失败（红色）→ 停止，提示用户

### Step 3: 路由准备
- 如果目标 flow 有 `route` 绑定，且当前不在该路由 → 先导航到目标路由
- 路由变量（`:param`）用 `variables` 中的对应值填充
- 如果目标元素有 `route` 限定但 flow 无 route 绑定 → 自动导航到元素的 route

### Step 4: 参数解析
- 从用户指令中提取 flow 所需变量（`variables` 中 `required: true` 的）
- 缺失必填参数 → 反 ask 用户
- 路由变量与 flow 变量分开解析

### Step 5: 执行 Flow
- 按 `flows.<name>.steps` 逐步执行
- 每步映射到对应的 Browser Bridge MCP 调用
- action 类型及映射：

| action | 用途 | Browser Bridge 方法 |
|--------|------|---------------------|
| `navigate` | 导航到 URL | `browser_navigation navigate` |
| `type` | 在目标元素中输入文本 | `browser_input type` |
| `click` | 点击目标元素 | `browser_input click` 或 `page.evaluate` (JS click) |
| `wait` | 等待条件满足 | `browser_dom wait` 或 `sleep` |
| `read_text` | 读取目标元素的文本内容 | `browser_dom text` 或 `browser_page text` |
| `scroll` | 滚动页面 | `browser_navigation scroll` |
| `press_key` | 按键操作 | `browser_input press_key` |
| `hover` | 悬停元素 | `browser_input hover` |
| `select` | 选择下拉选项 | `browser_input select_option` |
| `evaluate` | 执行自定义 JS | `browser_page evaluate` |

- 步骤中的 `$变量名` 替换为运行时值

### Step 6: 错误恢复
- 任何步骤失败时：
  1. 记录失败步骤和错误信息
  2. 导航回 `init_route` 重置环境
  3. 等待页面加载完成
  4. 重试（仅重试 1 次）
  5. 重试仍失败 → 停止，报告完整错误信息

### Step 7: 返回结果
- 提取 flow 执行后的关键输出（如页面文本、截图等）
- 以结构化方式呈现给用户

## Element 定位策略

加载站点手册后，按以下优先级定位元素：

1. 使用当前会话中已缓存的 elementRef（最快）
2. 使用 primary selector（手册中的第一个选择器）
3. primary 失败 → 尝试 fallback selector
4. fallback 也失败 → 尝试 JS evaluate 直接查找（如 `document.querySelector(...)`）
5. 全部失败 → 标记为 MISSING，停止执行

对于已知需要 JS click 的元素（如 DeepSeek 的发送按钮），优先使用 `page.evaluate` 而非 `browser_input click`。

## 参考文档

- `format-spec.md` — Tier 2 站点手册格式规范（YAML frontmatter schema）
- `validity-checking.md` — 实效检测协议
- `generation-workflow.md` — 半自动生成流程
- `exploration-methodology.md` — DOM 勘探方法论
