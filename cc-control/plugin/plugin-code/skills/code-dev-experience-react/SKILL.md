---
name: code-dev-experience-react
description: >
  React 最佳实践经验 — 一个功能有多种实现方案时，如何做取舍决策。
  触发条件：w-dev 中涉及 React 项目、需做实现方案决策时。
  引用方：w-dev
---

# React 实践经验

不是语法参考，是决策经验——面对多种实现方案时，怎么选。

## 决策框架

给定场景 → 列出候选方案 → 按"复杂度最低 + 状态范围最合适 + 重渲染最小"选 → 说明理由。

## 一、hook vs 组件 vs Context vs 状态库

| 场景 | 用哪个 | 理由 |
|------|--------|------|
| 单个组件内的一段逻辑 | 普通函数 / `useState` | 不需要额外抽象 |
| 逻辑要在多个组件复用 | 自定义 hook | 单一职责，`useXxx` 命名 |
| 多组件共享低频全局值（主题、语言、用户） | Context | 更新频率低，重渲染面可控 |
| 高频全局状态 | Zustand / Redux Toolkit | 选择器只重渲染订阅的切片，Context 会全量重渲染 |
| 只有一处用的复杂 UI 结构 | 组件组合 | 不需要全局状态 |

**判断口诀：状态越低越好**——能放本地就不提全局，能用一个 hook 就不用 store。

## 二、状态管理方案选择

| 状态特征 | 推荐 | 原因 |
|----------|------|------|
| 本地、少量 | `useState` | 内置，无样板 |
| 多字段、转换复杂 | `useReducer` | 状态转换集中在一个 reducer，可测试 |
| 更新频率低（主题/i18n/用户ID） | Context + reducer | 值不常变，重渲染代价可接受 |
| 更新频繁的全局数据 | Zustand | 近乎零样板，切片订阅，只重渲染相关组件 |
| 超大全局状态、需要时间旅行/调试 | Redux Toolkit | 完善的 devtools 与中间件生态 |

**关键警告**：Context 值一变，所有消费方都重渲染——高频更新的状态放进 Context 是性能杀手。

**派生值在渲染中计算，不放进 state**：能从现有 state/props 算出来的值，直接在渲染时算，不要 `useState` 再同步。

## 三、useEffect 的正确用法

`useEffect` 不是生命周期方法，是**与外部系统同步**（数据请求、订阅、定时器）。

- 状态派生（过滤、计算）→ 渲染中计算，不用 effect
- 响应 props 变化 → 用渲染中计算或 `useMemo`，不用 effect 同步
- effect 里建了订阅/定时器 → 必须返回清理函数，否则内存泄漏
- effect 依赖数组 → 别禁用 `exhaustive-deps`，重构或 memo 化依赖

## 四、组件拆分粒度

- props 超 5-7 个 → 拆
- 需要"and/or"描述组件 → 拆
- 一个状态只在某子树用 → 状态下沉到那棵子树（状态就近隔离重渲染）
- 通用组件 vs 业务组件分层：通用组件进 `components/ui/`，业务组件随 feature 走

## 五、常见反模式与替代

| 反模式 | 替代方案 |
|--------|----------|
| 列表用 index 做 key | 用业务 id / uuid |
| 内联对象/函数当 props（破坏 memo 浅比较） | `useMemo`/`useCallback` 或提取常量 |
| 把所有东西包 `useMemo`/`useCallback`"以防万一" | 先测量，再优化（memo 是优化工具不是默认） |
| prop drilling | 组合（compound）+ 就近提 Provider |
| 条件性调用 hook | hook 永远在顶层、顺序恒定 |
| God hook（一个 hook 管所有事） | 拆成多个单一职责 hook |
| 布尔开关驱动的万能组件 | 拆成显式变体组件 |
| 类组件（新代码） | hooks 函数组件 |

## 六、性能决策

- 渲染量大：展示型组件 `React.memo`，但先确认真的慢
- 输入频繁（搜索框）：`useDeferredValue` / 防抖
- 重渲染卡顿：状态下沉 + 只传需要的 props（`userName={obj.name}` 而非 `user={obj}`）
- 复杂表单/乐观更新（React 19）：`useActionState` / `useOptimistic`
