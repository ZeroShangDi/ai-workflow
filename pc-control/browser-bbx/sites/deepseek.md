---
name: deepseek
display_name: DeepSeek Chat
description: >
  操控 DeepSeek Chat (chat.deepseek.com) 进行 AI 对话。
  支持: 发送消息并获取回复、切换深度思考/智能搜索模式、创建新对话。
url: https://chat.deepseek.com
init_route: /
version: 1
generated: 2026-07-01
last_validated: 2026-07-01

routes:
  home:
    path: "/"
    description: 首页/新建对话页（也是 init_route）

  chat_detail:
    path: "/a/chat/s/:chat_id"
    description: 已有对话详情页

elements:
  chat_input:
    description: 消息输入框，页面唯一的 textarea 元素
    selectors:
      - selector: "textarea"
        type: css
        priority: primary
      - selector: "[placeholder*='发送消息']"
        type: css
        priority: fallback
      - selector: "document.querySelector('textarea')"
        type: js
        priority: fallback
    wait_for: visible
    dynamic: false

  send_button:
    description: >
      发送按钮。重要: Enter 键和 browser_input submit 均无法触发发送，
      必须使用 JS click() 点击此按钮。
    selectors:
      - selector: ".ds-button--primary[role='button']"
        type: css
        priority: primary
      - selector: "button[name='发送']"
        type: role
        priority: fallback
      - selector: "document.querySelector('.ds-button--primary')"
        type: js
        priority: fallback
    wait_for: visible
    dynamic: false

  deep_think_toggle:
    description: 「深度思考」开关按钮
    selectors:
      - selector: "深度思考"
        type: text
        priority: primary
      - selector: ".ds-toggle-button[aria-label*='深度思考']"
        type: css
        priority: fallback
    wait_for: visible
    dynamic: false

  web_search_toggle:
    description: 「智能搜索」开关按钮
    selectors:
      - selector: "智能搜索"
        type: text
        priority: primary
      - selector: ".ds-toggle-button[aria-label*='搜索']"
        type: css
        priority: fallback
    wait_for: visible
    dynamic: false

  chat_title:
    description: 顶部对话标题，可点击聚焦
    selectors:
      - selector: ".afa34042"
        type: class
        priority: primary
    wait_for: visible
    dynamic: false

  response_markdown:
    description: 最新一条 AI 回复的 markdown 内容区
    route: chat_detail
    selectors:
      - selector: ".ds-markdown:last-of-type"
        type: css
        priority: primary
      - selector: "document.querySelector('.ds-markdown:last-of-type')"
        type: js
        priority: fallback
    wait_for: visible
    dynamic: true
    wait_after_action: 2000

  new_chat_button:
    description: 侧边栏「新建对话」按钮
    selectors:
      - selector: "button[name='新建对话']"
        type: role
        priority: primary
    wait_for: visible
    dynamic: false

  sidebar_toggle:
    description: 侧边栏折叠/展开按钮（左上角）
    selectors:
      - selector: ".ds-button--iconLabelPrimary[role='button']"
        type: css
        priority: primary
    wait_for: visible
    dynamic: false

  conversation_list_item:
    description: 侧边栏中的对话列表项
    selectors:
      - selector: ".ds-conversation-item"
        type: css
        priority: primary
    wait_for: visible
    dynamic: true
    wait_after_action: 500

flows:
  send_message:
    description: 在输入框中输入消息并发送，等待 AI 回复后返回内容
    steps:
      - action: type
        target: chat_input
        value: "$message"
        clear: true
      - action: evaluate
        expression: "document.querySelector('.ds-button--primary').click()"
      - action: wait
        condition: time
        timeoutMs: 3000
      - action: read_text
        target: response_markdown

  toggle_deep_think:
    description: 切换「深度思考」开关状态
    steps:
      - action: click
        target: deep_think_toggle
      - action: wait
        condition: time
        timeoutMs: 500

  toggle_web_search:
    description: 切换「智能搜索」开关状态
    steps:
      - action: click
        target: web_search_toggle
      - action: wait
        condition: time
        timeoutMs: 500

  new_chat:
    description: 开始新的对话（点击侧边栏新建按钮）
    steps:
      - action: click
        target: new_chat_button
      - action: wait
        condition: element_visible
        target: chat_input
        timeoutMs: 5000

  open_conversation:
    description: 从侧边栏打开一个已有对话
    steps:
      - action: click
        target: conversation_list_item
      - action: wait
        condition: element_visible
        target: response_markdown
        timeoutMs: 5000

variables:
  message:
    description: 要发送给 DeepSeek 的消息内容
    required: true
    example: "你好，请帮我分析这段代码"
  chat_id:
    description: 对话 ID（路由变量 :chat_id），用于打开已有对话
    required: false
    example: "449e10b6-5ec3-481f-b661-ab5cd1de3373"

---

# DeepSeek Chat 操作手册

## 页面概述

DeepSeek Chat 是一个 AI 对话平台。主要交互区域：侧边栏（对话历史）、中央聊天区（消息显示）、底部输入栏（消息输入 + 模式开关 + 发送）。

## 初始化路由

`init_route`: `/`

选择原因: 首页即新建对话页，状态最干净，没有历史对话干扰，无路由参数依赖。出错时回到此页面可安全重置环境。

## 路由表

| 路由 Key | 路径 | 用途 |
|----------|------|------|
| home | / | 首页/新建空白对话 |
| chat_detail | /a/chat/s/:chat_id | 已有对话详情页 |

## 元素说明

| 元素名 | 路由 | 描述 | 主选择器 | 动态加载 |
|--------|------|------|----------|----------|
| chat_input | 全局 | 消息输入框（唯一的 textarea） | `textarea` | 否 |
| send_button | 全局 | 发送按钮 | `.ds-button--primary[role='button']` | 否 |
| deep_think_toggle | 全局 | 「深度思考」开关 | text: "深度思考" | 否 |
| web_search_toggle | 全局 | 「智能搜索」开关 | text: "智能搜索" | 否 |
| chat_title | 全局 | 顶部对话标题 | `.afa34042` | 否 |
| response_markdown | chat_detail | 最新 AI 回复内容 | `.ds-markdown:last-of-type` | 是 |
| new_chat_button | 全局 | 侧边栏新建对话按钮 | role:button[name='新建对话'] | 否 |
| sidebar_toggle | 全局 | 侧边栏折叠按钮 | `.ds-button--iconLabelPrimary` | 否 |
| conversation_list_item | 全局 | 侧边栏对话列表项 | `.ds-conversation-item` | 是 |

## 操作流程

### send_message — 发送消息并获取回复

在输入框中输入消息，点击发送，等待 AI 回复后返回内容。

- **参数**: `message` (必填) — 要发送的消息
- **超时**: 30s
- **注意**: 发送按钮无法通过 Enter 键触发，必须使用 JS click()

### toggle_deep_think — 切换深度思考

- **注意**: 切换后需要重新发送消息才能看到效果

### toggle_web_search — 切换智能搜索

- **注意**: 切换后需要重新发送消息才能看到效果

### new_chat — 开始新对话

点击侧边栏新建对话按钮，导航到 `/a/chat/new`。

### open_conversation — 打开已有对话

用于打开特定对话 ID 的已有对话。

- **参数**: `chat_id` (选填) — 对话 ID

## 注意事项

### 发送机制（重要）
- **Enter 键无法发送**：`browser_input` 的 `submit: true` 和 `press_key Enter` 均无效，只会在输入框中插入换行
- **必须用 JS 点击发送按钮**：`document.querySelector('.ds-button--primary').click()`
- 发送后 AI 回复需要 2-10 秒，取决于消息长度和是否开启深度思考

### 登录状态
- 非登录状态下只能进行有限次数的对话
- 登录后功能完整

### 选择器稳定性
- 设计系统类名（`ds-button`, `ds-markdown` 等）相对稳定
- 哈希化类名（如 `afa34042`, `b13855df`）每次构建都可能变化，避免作为 primary selector
- `textarea` 是唯一的，最稳定的入口

## 变更记录

- v1 (2026-07-01): 初始生成。发现 Enter 键无法发送、需要 JS click 的关键行为。定义 init_route 为 /a/chat/new。
