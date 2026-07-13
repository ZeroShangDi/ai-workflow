---
name: _template
display_name: 【模板】站点名称
description: >
  站点用途概述。一句话描述这个站点是干什么的，支持哪些自动化操作。
url: https://example.com
init_route: /path/to/stable/page
version: 1
generated: YYYY-MM-DD
last_validated: YYYY-MM-DD

# ============================================================
# 路由定义（单页面站点可省略 routes 节）
# ============================================================
routes:
  # route_key:
  #   path: "/:param1/:param2"        # 路由路径，:param 为变量占位符
  #   description: 该页面的用途

# ============================================================
# 可交互元素
# ============================================================
elements:
  # --- 元素定义模板 ---
  # element_key:                          # 语义化名称（英文，snake_case）
  #   description: 中文描述                # 这个元素是干什么的
  #   route: route_key                    # （可选）元素所属路由。无此字段 = 全局元素
  #   selectors:                          # 选择器列表，按优先级排列
  #     - selector: "选择器表达式"          # 选择器值
  #       type: css                       # css | class | role | text | js
  #       priority: primary               # primary | fallback
  #     - selector: "备用选择器"
  #       type: role
  #       priority: fallback
  #   wait_for: visible                   # visible | hidden | attached | none
  #   dynamic: false                      # true = 动态元素，实效检测跳过
  #   triggers: []                        # dynamic=true 时的触发条件
  #   wait_after_action: 0                # 交互后等待毫秒

# ============================================================
# 操作流程
# ============================================================
flows:
  # --- Flow 定义模板 ---
  # flow_key:                            # 流程名称（英文，snake_case）
  #   description: 中文描述               # 这个流程是干什么的
  #   route: route_key                   # （可选）流程绑定的路由，执行前会自动导航
  #   preconditions: []                  # 前置条件
  #   steps:
  #     - action: navigate               # navigate | type | click | wait | read_text | scroll | press_key | hover | select_option | evaluate
  #       # 以下为 action 相关参数，按需使用：
  #       url: "$url"                    # navigate: 目标 URL，支持 $变量 和 :param 路由变量
  #       target: element_key            # click/type/wait/read_text: 目标元素
  #       value: "$变量名"                # type: 输入文本
  #       clear: true                    # type: 是否先清空
  #       condition: element_visible     # wait: 等待条件 (element_visible | time)
  #       timeoutMs: 10000               # wait: 超时毫秒
  #       expression: "js代码"            # evaluate: JS 表达式

# ============================================================
# 运行时变量
# ============================================================
variables:
  # --- 变量定义模板 ---
  # variable_key:
  #   description: 用途说明
  #   required: true
  #   default: "默认值"
  #   example: "示例值"

---

# 【模板】站点名称

## 页面概述

（一句话描述站点用途和主要交互区域）

## 初始化路由

`init_route`: `/path/to/stable/page`

选择原因: （为什么选这个路由作为初始化/重置点）

## 路由表

| 路由 Key | 路径 | 用途 |
|----------|------|------|
| route_key | /path/:param | 描述 |

## 元素说明

| 元素名 | 路由 | 描述 | 主选择器 | 动态加载 |
|--------|------|------|----------|----------|
| element_key | 全局 | 描述 | primary selector | 否 |
| element_key | route_key | 描述 | primary selector | 否 |

## 操作流程

### flow_key — 流程描述

（描述用途、所需参数、预期结果）

- **绑定路由**: route_key
- **参数**:
  - `variable_key` (必填/选填): 描述
- **超时**: Xs

## 注意事项

- 注意事项 1
- 注意事项 2

## 变更记录

- v1 (YYYY-MM-DD): 初始生成
