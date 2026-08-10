---
name: code-dev-experience-vue
description: >
  Vue 最佳实践经验 — 一个功能有多种实现方案时，如何做取舍决策。
  触发条件：w-dev 中涉及 Vue 项目、需做实现方案决策时。
  引用方：w-dev
---

# Vue 实践经验

不是语法参考，是决策经验——面对多种实现方案时，怎么选。

## 决策框架

给定场景 → 列出候选方案 → 按"复杂度最低 + 响应式正确 + 副作用边界清晰"选 → 说明理由。

## 一、composable vs 组件 vs store vs 工具函数

| 场景 | 用哪个 | 理由 |
|------|--------|------|
| 无状态纯逻辑 | 普通工具函数 | 不需要响应式 |
| 单组件内响应式逻辑 | 组件内 `ref`/`computed` | 不需要抽象 |
| 响应式逻辑多处复用 | composable | 封装状态 + 副作用，`useXxx` 命名 |
| 多个组件共享的全局数据 | Pinia store | 单一数据源，devtools 支持 |
| 复杂 UI 结构 | 组件组合 | 不用状态层 |

**纯工具函数不要写成 composable**——composable 只用于有状态或生命周期依赖的逻辑。

## 二、composable 设计规范

- **无隐藏副作用**：不在 composable 内调 `provide`/`inject`、不内部改 store 状态、不直接操作 DOM。需要时作为参数传入或返回 action 交给调用方
- **只返回响应式状态 + action**：状态用 `readonly()` 保护，更新走 action，防止消费方直接改
- **多参数用 options 对象**：`useFetch(url, { method, timeout, retries })`，避免长位置参数错位
- **小 composable 组合大 composable**：如 `useMouse` 由 `useEventListener` 组成

### 响应式入参陷阱（MaybeRefOrGetter）

入参要响应式时，不要传裸值——`useFeature(props.foo)` 在 composable 内部 `computed` 不会随 props 更新。

```js
// 错误：传入静态值，内部 computed 不更新
useFeature(props.foo)
// 正确：传 getter，保持响应式
useFeature(() => props.foo)
```

规范：参数应响应式时收 `Ref` 或 getter，静态时收裸值；内部统一 `toValue()` 读取。

## 三、响应式数据组织

- **解构 `reactive()` 丢失响应式**——用 `toRefs()`/`toRef()` 保持引用
- **整体替换用 `ref()`**：`reactive` 变量整体重新赋值不生效；替换整个对象用 `ref` + `.value`，局部更新用 `Object.assign(state, newData)`
- **`shallowRef`**：整个对象被整体替换（大列表刷新）时用，省去深层响应式跟踪
- **`computed` 必须纯**：绝不在 computed 里做副作用/异步，放 `watch`
- **`watch` 源写 getter**：`watch(() => props.foo, ...)`，不要 `watch(props.foo, ...)`（静态值，不响应）
- **副作用用 `watch` 不用 `watchEffect`**：`watchEffect` 自动追踪全部依赖、每次变化都跑，只用于轻量派生

## 四、组件通信方式选择

| 场景 | 方式 | 理由 |
|------|------|------|
| 父子直接传数据 | props | 单向数据流，显式 |
| 子改父状态 | emits | 事件显式声明 |
| 跨多层传递低频数据（主题/用户） | provide/inject | 跳过 prop drilling |
| 全局共享高频数据 | Pinia | 单一数据源 + devtools |
| 兄弟/无关组件 | Pinia | 比事件总线可追踪 |

**依赖方向**：props 下传、emits 上抛、全局才用 store。provide/inject 是隐式契约，少用并文档化。

## 五、常见反模式与替代

| 反模式 | 替代方案 |
|--------|----------|
| 忘写 `.value` | 记住顶层读写都走 `.value` |
| computed 里发请求 | 移到 `watch` 或事件处理器 |
| watchEffect 里放网络请求 | `watch` + 显式源 |
| 解构 reactive 丢响应式 | `toRefs`/`toRef` |
| 订阅/监听器不清理 | `onUnmounted` 里清理 |
| 列表用 index 做 key | 用业务 id（index 在重排时导致 DOM 复用错乱） |
| 组合式函数内部偷偷 provide | 拆出显式 provider 组件 |

## 六、性能决策

- 大列表整体刷新：`shallowRef` + 稳定 key
- 输入频繁（搜索）：防抖或 `watch` + 延迟执行
- 派生开销大：`computed` 缓存（惰性求值，依赖不变不重算）
- 组件体积超 50 行逻辑：抽 composable，保持 `<script setup>` 按关注点分组
