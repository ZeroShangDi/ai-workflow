# React 中每份状态应该由哪个组件或模块拥有？
关键词：React状态、单一真值、状态管理
答案：状态应由能维护其不变量且范围最小的组件拥有：单组件交互状态留在本地；多个组件必须同步时，先提升到它们最近的共同父级；多个远距离消费者或跨页面流程需要共享时，再评估 Context 或项目已有状态库。选择依据是状态的所有者、消费者和更新关系，不以“全局/高频”标签直接指定某个库。先避免重复存储可推导状态；引入外部状态方案前核对项目现有做法和实际订阅需求。参考：[共享状态](https://react.dev/learn/sharing-state-between-components)、[状态结构](https://react.dev/learn/managing-state)。

# 什么时候应把组件逻辑提取为自定义 Hook？
关键词：自定义Hook、逻辑复用、状态共享
答案：当多个组件需要复用同一段有状态逻辑或副作用时，可提取自定义 Hook；它复用逻辑，但每次调用通常拥有独立的 Hook 状态。若调用方必须读写同一份状态，应把状态提升至共同所有者，或使用显式共享机制，不能仅靠把逻辑改写成 Hook 达成共享。Hook 应以 `use` 开头，并只在组件或其他 Hook 的顶层调用。参考：[复用逻辑与自定义 Hook](https://react.dev/learn/reusing-logic-with-custom-hooks)、[Hook 调用规则](https://react.dev/reference/eslint-plugin-react-hooks/lints/rules-of-hooks)。

# React 的 Effect 应承担什么工作？
关键词：useEffect、副作用、清理
答案：Effect 用于让组件与 React 之外的系统保持同步，例如订阅、浏览器 API 或第三方控件；由 props/state 可直接推导的值在渲染中计算，不用 Effect 再写回状态。Effect 的依赖应反映其读取的响应式值；建立订阅、计时器或连接时提供相应清理，使重新同步和卸载安全。异步请求要依据具体时序设计取消或过期结果保护。若 Effect 只是转发事件处理或维护派生状态，先重看状态结构。参考：[useEffect](https://react.dev/reference/react/useEffect)。

# React 列表中的 key 应如何选择？
关键词：列表渲染、key、组件状态
答案：使用数据中稳定且在同级项间唯一的标识，让 React 在插入、删除或排序后继续对应同一条目。不要在渲染时生成随机 key；若列表可能重排或增删，数组索引可能把局部状态错配到另一项。若确实是固定且不变的静态列表，索引的风险不同，应按数据生命周期判断。`key` 仅供 React 识别，不会作为普通 prop 传入。参考：[渲染列表](https://react.dev/learn/rendering-lists)。

# 什么时候应该使用 React 的 memoization？
关键词：React性能、memo、useMemo
答案：先确认用户可感知的交互确有重复计算或重渲染成本，再用 Profiler 或代表性测量定位，并在能减少该成本的边界使用 `memo`、`useMemo` 或 `useCallback`。它们是性能优化，不应承载程序正确性或状态持久性；依赖项必须完整，缓存被丢弃时行为仍应正确。先检查状态是否放得过高、Effect 是否造成额外渲染，以及子组件组合是否能避免传播。React Compiler、React 版本与项目配置会影响手动 memo 的必要性，实施前核对当前项目。参考：[useMemo](https://react.dev/reference/react/useMemo)、[memo](https://react.dev/reference/react/memo)。
