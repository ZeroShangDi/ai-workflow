---
name: code-dev-design
description: >
  设计与实现决策 — 覆盖样式生成、函数设计、组件设计、代码组织和第三方依赖引入。
  触发条件：w-dev 涉及设计决策、方案取舍时；写样式、拆组件、选依赖、定目录结构时。
  引用方：w-dev
---

# 设计与实现决策

不是语法参考，是决策经验——面对多个可选方案时，怎么选、怎么落地。基础规则见 code-dev-rule，这里讲取舍。

## 一、样式生成（style）

### 方案选择

| 方案 | 适合 | 运行时开销 | 类型安全 |
|------|------|-----------|---------|
| Tailwind / 原子类 | 快速开发、设计系统强约束 | 无 | 无 |
| CSS Modules | 组件化应用（React/Vue） | 无 | 无 |
| CSS-in-JS（styled-components/Emotion） | 样式值由 JS 运行时计算 | 有 | 可选 |
| BEM | 全局共享样式、CMS、大团队 | 无 | 无 |

**选型原则：**

- 默认 Tailwind + CSS 变量；复杂组件（关键帧动画、伪元素、条件类超 20 个）退回 CSS Modules
- 复用类名用 TS 组件封装（`cn()` = clsx + tailwind-merge），不要用 `@apply`——它违背原子类初衷且产生死 CSS
- CSS-in-JS 只在样式值确实依赖运行时状态时用，否则是纯开销
- 没有唯一正确答案：选型是权衡，选定后文档化并强制执行，一致性比正确性重要

### 设计令牌

- 颜色、间距、字号、圆角、阴影、断点统一收敛为 CSS 变量，定义在 `:root`
- 主题通过 `[data-theme="dark"]` 覆盖变量实现，业务代码不写死值
- 命名：`--color-primary`、`--space-4`、`--radius-md`（类别-语义-序号）

### 防样式债

- 特异性控制在 0-1-0 ~ 0-2-0，禁 ID 选择器、禁 `!important`——想用 `!important` 时改层顺序或选择器
- 用 `@layer reset, base, components, utilities` 控制级联顺序，第三方库锁进 `layer(vendor)`
- 样式债比代码债累积更快：全局作用域 + 死代码 + 特异性战争是三大主因
- Stylelint 强制：`selector-max-specificity`、`declaration-no-important`、`no-descending-specificity`

## 二、函数设计（function）

基础规则（单一职责、参数 ≤3、错误处理）见 code-dev-rule。这里补设计模式的取舍。

### 何时用什么模式

| 场景 | 模式 | 说明 |
|------|------|------|
| 同一逻辑不同分支实现 | 策略 | 用 map 注册策略，替代 if-else 链 |
| 创建过程复杂/有变体 | 工厂 | 集中创建逻辑，返回统一接口 |
| 横切逻辑（日志、重试、鉴权） | 高阶函数 / 装饰器 | `withRetry(fn)`，不侵入业务函数 |
| 多个步骤可选组合 | 组合 | 小函数拼装，而非一个大函数开关 |

### 决策点

- **纯函数优先**：逻辑与副作用分离，副作用推到边界（事件处理器、service 层、store action）
- **返回值约定统一**：一个模块内选一种"无结果"表达（null / undefined / Result / throw），混用是 bug 源头
- **异常 vs 返回错误**：可预期的业务失败用返回值（用户没权限、记录不存在）；不可预期的系统失败用异常
- **高阶函数**：只在"通用流程 + 可插拔步骤"时用，不要为抽象而抽象

### 反模式

- 布尔标志参数（`doX: true`）→ 拆成两个函数
- 隐式依赖（函数内部读模块级状态）→ 显式传参
- 用"and/or"才能描述的函数 → 拆
- 函数体内出现超过 2 个 `if` 说明分支行为不同 → 考虑策略 map

## 三、组件设计（component）

### 设计原则

1. **单一职责 + 最少 props** — props 超 5-7 个说明组件职责过重；相关 props 收敛为对象
2. **组合优于配置** — 用 `<Card><Card.Header>…` 组合，不用 `<Card showHeader headerAlign="left" />` 布尔开关堆叠
3. **props 用联合类型** — `variant: 'primary' | 'secondary' | 'danger'`，不用布尔判断意图
4. **受控 + 非受控双支持** — `value` 受控（状态在父组件）、`defaultValue` 非受控；两者都给时文档化行为
5. **children 优先于 label prop** — `<Button>点击</Button>` 好于 `<Button label="点击" />`
6. **继承原生元素类型** — `interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>`，自动获得所有原生属性与 ARIA

### 组合模式选择

| 模式 | 场景 | 代价 |
|------|------|------|
| Compound（`Select.Option`） | 多部件共享内部状态 | API 面变大 |
| Slots / children | 单组件带插槽 | 灵活性较低 |
| Render props / children 函数 | 父组件要控制渲染数据 | 学习曲线陡 |
| Headless（Radix 等） | 行为 + 可访问性，不绑视觉 | 全部样式自写 |
| Polymorphic（`as` prop） | 同一 API 渲染不同元素 | 类型复杂 |

### 反模式

- **God Component** — 布尔开关驱动的万能组件，拆
- **状态 props 爆炸** — `isLoading`/`isError`/`isSuccess` 三连 → 用一个状态字段或数据驱动渲染
- **模式切换 prop** — `type="dialog"|"drawer"` 切模式 → 拆成独立变体组件
- **泄露实现细节** — 把内部类名当公开 API；用 `data-state="error"` 暴露状态
- **`className` 渗透** — 每个内部元素都收 className → 用组合

### 可访问性默认开启

- 语义 HTML 优先，不用 div 模拟按钮；必要处提供 `aria-label`
- 组件库回归测试必写——一个组件改动可能炸掉几十个消费方

## 四、代码组织（organization）

### 按功能组织，不按技术类型组织

```
src/
  features/user/      # 一个功能 = 自包含小应用
    components/       #   该功能的 UI
    api/              #   该功能的接口
    hooks/            #   该功能的状态/副作用
    index.ts          #   公开 API
  shared/             # 跨功能共享的通用件
```

技术类型目录（`components/`、`services/`、`utils/` 平铺）在项目变大后会变成垃圾场——相关代码散落各处，改一个功能要跨目录跳。

### 边界规则

- 每个模块只暴露 `index.ts` 里的公开 API，内部文件禁止被外部引用
- 依赖方向单向：功能层可依赖共享层，反向不行（用 ESLint import 规则强制）
- 模块间通信传原始 ID，不传对象，降低耦合
- 抽象（接口）与实现分离：功能依赖抽象，替换实现（如换存储后端）不碰业务代码

### 粒度平衡

- 拆太细：大量小模块 → 构建复杂、样板代码多
- 拆太粗：模块变大 → 又变回单体
- 规则：一个功能目录能独立演进、独立测试、独立理解时粒度合适

### 反模式

- `utils/` 垃圾桶——没有共同主题的工具函数堆一起
- 循环依赖——两个模块互相 import，用接口或事件解耦
- barrel 文件过度——`index.ts` 只导出公开面，不导出全部内部

## 五、第三方依赖引入（package）

### 引入门槛

1. 能自己实现且在 200 行内 → 自己写，不引入
2. 原生能力 / 框架 / 已有代码能解决 → 不引入
3. 解决复杂问题（加密、日期、图表）才有引入价值
4. 一个依赖解决一类问题，不引入功能重叠的库

### 评估清单（引入前逐项过）

| 维度 | 检查项 |
|------|--------|
| 活跃度 | 近 1 年有发布、issue 被响应、多维护者 |
| 规模 | 周下载量、GitHub stars、Bundlephobia 包体积 |
| 安全 | `npm audit` 无高危漏洞、安装脚本无可疑行为（curl/wget/混淆代码） |
| 质量 | 源码可读、文档完整、有测试 |
| 许可 | MIT/Apache 可用，GPL/AGPL 需法务确认 |
| 替换成本 | 若被弃用，能否 fork 或三天内重写 |

### 引入后的纪律

- 适配器层封装：业务代码不直接 import 第三方库，经一层薄封装——换库只改一处
- 版本锁定：`package-lock.json` + 精确版本，CI 用 `npm ci`
- 依赖更新一个一测，看重写文档的破坏性变更说明
- 定期 `npm audit`，高危不修复就记录为技术债
- 供应链风险：慎用安装期执行脚本的包，必要时 `--ignore-scripts`

### 反模式

- 为"流行"引入——选最合适的，不是最流行的
- 小工具链引入多个功能重叠库（dayjs + date-fns + moment 共存）
- 无锁定直接引 `^latest`，重现不了构建
- 把库当黑盒到处直接用，弃用时全线返工
