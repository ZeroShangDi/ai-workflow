---
name: code-dev-performance
description: >
  性能优化最佳实践 — 常见性能问题和优化模式。
  触发条件：涉及性能敏感的代码时。
  引用方：w-dev
---

# 性能优化最佳实践

## 优化原则

1. **先测量，再优化** — 没有基线不要动。性能问题靠测量定位，不靠猜
2. **优化关键路径** — 用户感知的路径优先：首屏、交互响应、核心操作
3. **20% 的优化解决 80% 的问题** — 先找最大瓶颈，不撒胡椒面
4. **性能预算** — 关键指标设预算（LCP < 2.5s、INP < 200ms、CLS < 0.1），CI 里防回归

## 常见性能反模式

| 反模式 | 表现 | 修复 |
|--------|------|------|
| N+1 查询 | 列表每行查一次库 | 预加载/join/批量查询 |
| 不必要的重渲染 | 父组件一变，整棵子树重渲染 | 状态就近下沉、memo、只传需要的 props |
| 内存泄漏 | 定时器/监听器/订阅不清理 | 卸载时清理（onUnmounted/useEffect cleanup） |
| 长任务阻塞主线程 | 同步处理大数组/图片 | 拆任务（scheduler.yield）、Web Worker 移出主线程 |
| 渲染前阻塞的同步代码 | 首屏前跑大量同步逻辑 | 延迟到交互后、异步化 |
| 无限大列表全量渲染 | 渲染上千行 DOM | 虚拟滚动（100+ 项） |
| 布局抖动 | 读布局和写样式交替 | 批量读、批量写，CSS transform 代替动画 |

## 前端性能

### 首屏加载（LCP）

- LCP 元素（主图）`fetchpriority="high"` + preload，首屏不 lazy-load
- 关键 CSS 内联，其余延迟；`@import` 禁用（渲染阻塞 + 串行请求）
- 字体 `font-display: swap` + WOFF2 + preconnect
- 路由级代码分割（dynamic import），三方脚本 async/defer
- 图片：AVIF/WebP + `srcset`/`sizes` 按需尺寸，首屏外的 `loading="lazy"`

### 交互响应（INP）

- 主线程长任务（>50ms）拆碎，`scheduler.yield()` / `setTimeout(0)`
- 滚动/触摸监听 `passive: true`
- 输入防抖/节流，状态批量更新
- 动画用 CSS transform/opacity，不用 JS 改 layout 属性

### 视觉稳定（CLS）

- 所有图片/视频显式 `width`/`height` 或 `aspect-ratio`（最有效的单条修复）
- 动态内容预留空间（骨架屏 / min-height）
- 内容不要从上方插入（prepend 会造成位移）

### 内存管理

- 定时器、事件监听、订阅、observer 都要在卸载时清理
- 避免闭包持有大对象；大列表被替换时释放引用
- `shallowRef`（Vue）/ 稳定的 key，避免意外长期持有 DOM

## 后端性能

### 数据库

- 查询只取需要的字段和行，避免 `SELECT *` 拉全表
- 命中索引：explain 检查，避免在索引列上做函数运算
- 分页用游标/offset 但注意深度分页性能
- 读多写少的数据加缓存（Redis/内存），缓存失效策略明确

### 缓存策略

- 写直（write-through）还是旁路（cache-aside），按一致性要求选
- 缓存粒度：整表 vs 单行；失效：主动更新 vs TTL
- 热点数据防缓存击穿（单 key 过期重建用互斥锁）

### 并发

- 明确并发控制：锁、乐观锁版本号、队列
- 事务尽量短，避免长事务持锁
- 需要时可异步化（消息队列）解耦慢操作

## 性能测量工具

- 浏览器：DevTools Performance / Coverage（找出 20-30% 未执行的 JS）/ Lighthouse
- 线上：RUM（真实用户）、LoAF（长动画帧定位卡顿脚本）、Core Web Vitals
- 后端：链路追踪、慢查询日志、Apdex
