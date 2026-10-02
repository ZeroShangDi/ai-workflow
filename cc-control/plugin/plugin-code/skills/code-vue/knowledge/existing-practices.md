# 什么时候应把 Vue 逻辑写成普通函数、composable 或组件？
关键词：composable、逻辑复用、组件组合
答案：无响应式状态和生命周期需求的计算优先用普通函数；需复用响应式状态、监听或生命周期行为时用 composable；需要复用界面结构与交互契约时用组件。composable 也可用于按逻辑关注点组织单个组件，不必等到多个调用方出现。不要仅为缩短文件或达到行数阈值抽取。参考：[Vue Composables](https://vuejs.org/guide/reusability/composables)。

# Vue composable 需要接受响应式输入时，如何避免丢失更新？
关键词：响应式输入、toValue、watch
答案：静态输入可直接传值；需要跟随变化时传 `ref` 或 getter，并在 `watch`/`watchEffect` 的依赖追踪范围内读取或用 `toValue()` 归一化。仅在函数调用时读取一次再保存普通值，不会自动追踪后续变化。是否同时支持普通值、ref、getter，取决于 composable 的真实调用契约；使用 `toValue()` 等 API 前核对项目 Vue 版本。参考：[Composables 的响应式参数](https://vuejs.org/guide/reusability/composables#accepting-reactive-state)。

# Vue composable 返回值怎样组织，才能让解构后的状态保持响应式？
关键词：ref、reactive、解构响应式
答案：多个响应式值通常以普通对象返回、每个属性是 `ref`，调用方解构后仍保留各 ref 的响应关系。直接解构 `reactive` 对象的属性会取出当时的值，失去与原代理属性的连接；需要逐项导出时用 `toRef`/`toRefs`，或保留对象访问。选择 `ref` 还是 `reactive` 还要看是否需要整体替换以及调用方契约，不把单一写法当通则。参考：[Composables 返回值](https://vuejs.org/guide/reusability/composables#return-values)、[响应式基础](https://vuejs.org/guide/essentials/reactivity-fundamentals)。

# `<script setup>` 中解构 props 后，响应式行为受哪些条件影响？
关键词：props解构、Vue版本、响应式
答案：普通 `props` 对象的属性访问可被响应式追踪；把属性值作为普通值传给外部函数，通常不会保留响应式来源，需要传 `() => props.foo` 等 getter。`<script setup>` 的 props 解构行为与 Vue 版本有关：Vue 3.5+ 会由编译器在该块内保留响应式，3.4 及之前则需按普通解构值处理。对外传参时显式传 getter 可使依赖关系清楚；改动前先核对项目版本和编译上下文。参考：[Props 响应式解构](https://vuejs.org/guide/components/props#reactive-props-destructure)。

# Vue 中派生值、明确监听和自动追踪副作用分别何时使用？
关键词：computed、watch、watchEffect
答案：由响应式状态纯粹计算得出的值用 `computed`；需要精确指定触发源、访问新旧值或配置时序时用 `watch`；依赖自然来自副作用函数读取、无需显式区分来源时可用 `watchEffect`。不要在 `computed` getter 中执行请求或修改状态；副作用要考虑清理、过期结果和组件卸载。`watchEffect` 并非一概禁止，选择取决于依赖是否应显式可见及回调语义。参考：[Computed](https://vuejs.org/guide/essentials/computed)、[Watchers](https://vuejs.org/guide/essentials/watchers)。

# Vue 组件之间应如何传递数据和维护共享状态？
关键词：props、emits、provide、状态归属
答案：父子之间以 props 向下传输入、以事件向上表达变化；深层后代确实需要同一依赖时可用 `provide/inject`，并让状态写入权尽量留在 provider，通过 action 暴露修改能力；跨页面或广泛共享状态才评估项目已有 store。避免仅因组件层级多就引入全局状态，也避免多个消费者直接修改同一份共享状态。参考：[Provide / Inject](https://vuejs.org/guide/components/provide-inject)。

# Vue composable 中创建的副作用怎样处理 SSR 与组件卸载？
关键词：副作用清理、SSR、生命周期
答案：订阅、事件监听和计时器应有与创建配对的清理；组件作用域内创建的 watcher/composable 副作用应确认会随组件卸载停止。访问 DOM 或浏览器专属 API 的操作应放在客户端生命周期中，不能在 SSR 初始化阶段假设 `window` 或 DOM 存在。若副作用不依赖组件实例生命周期，需明确由谁持有和释放。参考：[Composables 副作用](https://vuejs.org/guide/reusability/composables#side-effects)、[Watchers 生命周期](https://vuejs.org/guide/essentials/watchers#stopping-a-watcher)。
