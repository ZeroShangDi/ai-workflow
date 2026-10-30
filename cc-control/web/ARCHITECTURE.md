# 前端目录结构

2026-09-13：用户已提前授权继续，目录重构已实施。仅修改 web/，不修改 server、cli、根目录 tests 或其他模型正在处理的文件。以执行时的最新工作区为准，保留已有改动。

```text
web/src/
├── main.jsx
├── App.jsx                       # 兼容应用入口，转发到 app/index
├── app/
│   ├── index.jsx                 # 应用入口与页面路由组装
│   └── hooks/                    # 项目选择、Run 选择、应用级数据协调
├── layouts/
│   └── WorkspaceLayout/
│       ├── index.jsx             # 整体布局组装
│       ├── components/           # Sidebar、Topbar、StatusBar、ViewRail
│       └── styles.css
├── pages/
│   ├── Run/
│   │   ├── index.jsx             # 组装输出区、输入区和右侧概览
│   │   ├── components/
│   │   │   ├── Output/
│   │   │   ├── Composer/
│   │   │   └── Overview/
│   │   ├── hooks/
│   │   └── model.js
│   ├── Tasks/                    # index + components/List、Detail + hooks/model
│   ├── Decisions/                # 同上，独立决策动作
│   ├── DynamicReview/            # 同上，独立提案审批动作
│   ├── Logs/                     # index + components/Output、Controls + hooks/model
│   ├── Diagnostics/              # 保留旧诊断入口及模型
│   └── WbsTree/                  # 保留旧 WBS 入口及模型
└── shared/
    ├── api/
    │   └── index.js              # 只定义接口地址，包括参数化地址
    ├── components/
    │   ├── ui/                   # 非业务公共组件库
    │   │   ├── Button/
    │   │   ├── Input/
    │   │   ├── Select/
    │   │   ├── EmptyState/
    │   │   └── DetailField/
    │   └── business/             # 可跨页面复用的业务组件
    │       ├── RunSelect/
    │       ├── StatusBadge/
    │       └── ReviewRecord/     # 记录展示，不混合决策和提案的动作规则
    ├── hooks/                    # 通用请求操作状态、轮询等
    ├── lib/
    │   ├── http.js               # fetch/WS、作用域、错误处理
    │   └── format.js             # 非页面专用的数据格式化
    └── styles/                   # token 入口、reset、全局基础样式
```

## 边界

- pages 与 features 合并，不再设置 features 层。各页面 index 负责组装，不承载完整页面实现。
- 页面私有组件按职责放入 components 内的文件夹，样式就近维护；不要单纯把大文件原样搬入另一个目录。
- 非业务组件不依赖接口和业务实体；业务公共组件可以理解 Run、任务、决策，但不依赖具体页面。
- shared/api 仅包含 URL 常量或生成 URL 的函数；HTTP/WS 传输置于 shared/lib/http.js，页面请求和业务动作在对应 hooks 中。
- 只有已复用或有明确跨页面用途的组件进入 shared。避免把每个标签拆成组件。
- 决策页和动态复审页分别维护业务规则，可共用记录展示，避免使用 dynamic 开关混合两套业务。
- 保持现有功能和 UI，不补数据层、后端接口或会话组件体系，仍使用原始输出更新。
- 保留已有诊断/WBS入口。根目录 tests 引用的旧前端模块必要时仅留兼容 re-export，不改其他模型的测试文件。
- 构建验证输出 web/dist，避免写入 server。验证脚本如需持久保存在 web 内。

## 维护顺序

1. 检查最新 web 改动，提取接口地址、请求封装和公共组件。
2. 拆整体布局以及应用级状态；拆五个页面的组装、组件、hooks、model。
3. 拆分并就近维护样式，清理旧大文件，仅保留必要兼容出口。
4. 验证构建、lint、五页交互及响应式，检查与重构前的视觉和行为一致。

## 当前兼容边界

- `src/views/` 只剩旧模型路径的 re-export；没有页面组件，也没有重复模型实现。
- `src/api/client.js` 只转发 `shared/lib/http.js`，供既有测试/消费者兼容。
- 旧 dashboard、run-shell、decision 模型保存在 `shared/lib/legacy`，待相关测试维护者一起确认后再移除。
- `shared/components/styles.css` 放列表/详情面板等公共样式；Run 输入区、概览及日志样式已就近拆分。公共 token 仍从既有设计文件引用，不复制数值。
- 不安装新的 UI 框架；公共组件库由当前实际使用的 Button、Input、Textarea、Select、EmptyState、DetailField 组成。
- 验证：构建输出 `web/dist`；ESLint 无错误无警告；隔离模拟接口检查五页、四种视口、操作参数及无浏览器异常。

## 2026-09-14 架构审查与扩展约定

### 依赖与状态

- 依赖方向是 `app → layouts/pages → shared`；页面之间不互相 import。`web/tests/architecture.test.mjs` 检查反向依赖。
- `app/routes.js` 是页面注册入口：导航、按需加载、页面读取资源集中注册；`router.js` 处理 URL、历史回退和项目/Run 选择，未知页面回落到 Run。增加页面先注册路由，再实现 page/index 组装。
- 项目/Run/页面选择放 URL；服务端快照由 `useWorkspace` 协调；筛选、选中项、输入草稿由页面 hook 管理。跨页面公共渲染进入 business；纯交互进入 ui。暂不引入全局状态库。
- `usePolling` 保证同一轮询通道不重叠，卸载取消读取；调用方负责错误展示。事件使用 seq 增量、最多保留 3000 条，处理重启和截断提示。页面切换只读取需要的资源。
- `useAction` 防止同一动作重复提交，展示结果并刷新读模型；写入不自动重试，避免重复执行。后台快照不当作永久缓存。
- 页面边界用 ErrorBoundary 隔离渲染错误，Suspense 展示加载态；接口异常有重试入口。旧 Diagnostics/WBS 保留兼容实现及各自轮询，本期不重做产品布局。

### 接口与平台

- `shared/api/index.js` 仅 URL 定义；`shared/lib/http.js` 负责项目/会话作用域、JSON、HTTP 错误、15 秒默认超时和 AbortSignal。页面 hooks 处理业务含义。
- `shared/lib/transport.js` 是平台适配入口，默认 fetch/WebSocket；桌面壳未来可以注入相同接口的 IPC 适配器，不要求页面理解 IPC。当前没有实现桌面桥接或新增 server 能力。
- 不把 runId 混作 sid：runId 是业务运行标识，sid 是 server 会话槽。写操作始终绑定当前项目。
- 配置不存密钥。开发代理使用 AWF_SERVER；生产同源请求。登录/鉴权能力等 server 提供后在传输入口统一接入，不在组件里散落实现。

### 换肤、组件与资源

- 深色主题继续导入现有 Figma token：`docs/design/cc-work.tokens.css`，本次只读。`shared/theme/styles.css` 覆盖语义颜色，结构、间距、字号仍使用原 token。
- `shared/theme/index.js` 管理主题白名单与本机偏好，`data-theme` 是换肤扩展点；浅色是验证扩展点的预览主题，未作为已确认设计稿。正式设置页以后调用 applyTheme 即可。
- 图标原始 Figma SVG 在 `shared/assets/icons`，经 `shared/assets/index.js` 与 Icon 组件导入，由 Vite 管理哈希。不引用会过期的远程资源 URL。新增资源按 icons/images/fonts 分类，只有必须保留固定地址的文件才放 public。
- 页面样式就近维护，共享卡片样式不依赖其他页面 CSS；预览控制样式只随开发组件加载。组件拆分以可独立变化的职责为边界，不逐标签拆分。
- 窄屏主次面板纵向排列、独立滚动，项目列表使用抽屉，支持 Escape、焦点循环与关闭后恢复焦点。状态不只用颜色表达；输入有 label，筛选按钮有 pressed 状态。
- 数据按文本渲染，不使用原始 HTML 注入。语言文案目前中文集中在展示层；若正式增加多语言，再抽取词典，不先增加未使用的依赖。

### UI 校验范围

对照 Figma `ULzSTHZS6fW3uT08eBUcNe`：Run `168:1701`、决策 `170:2021`、日志 `10:618`。保持布局与语义 token，调整侧栏图标、记录卡片/分段筛选/详情标题、日志紧凑行、矩阵首尾聚合。任务 `196:1941` 和动态复审 `196:1945` 仍是范围占位，沿用共同组件风格，没有宣称像素级最终确认。会话仍是原始输出；不添加 server 缺失的 Agent 日志、采纳状态等字段或操作。

### 验证与交付

- `npm --prefix web run lint`
- `npm --prefix web test`：接口作用域/超时、mock 状态流转、路由参数、矩阵和依赖方向。
- `npm --prefix web run build -- --outDir dist`：验证产物仅写 web；生产 tree-shaking 排除 mock。
- `web/mock/tests/browser.cjs`：真实浏览器走 mock transport，无路由拦截，覆盖七页四种宽度和完整时间轴。需要安装 Playwright 或设置 PLAYWRIGHT_MODULE，详见 mock/README。
- 与根目录测试兼容的导出继续保留，当前 API client 的 13 项已有测试也通过；不改根目录 tests。

本机没有找到 Code Principles 技能，因此没有声称调用它。此次按依赖方向、单一职责、状态归属、可替换传输和行为测试审查。

本轮结果：ESLint 0 错误/警告；web 下 10 项 Node 测试通过；既有 API client 13 项测试通过；浏览器覆盖 1440/1024/768/390 宽度的五页，验证启动、暂停、发送、回复、审批、替代决策、清屏、主题、空数据、接口异常和浏览器回退，未发起真实 API 请求。构建产物无 mock fixture。正式后端端到端执行和桌面 IPC 本期未验证。

## 2026-09-14：完整 Mock 时间轴

所有模拟数据、日志样本、状态机、预览 UI 和模拟测试收敛至 `web/mock/`；正式页面仍在 `src/pages/`，通过统一 API 消费结果。新增项目/Plan 页面与目录选择器、结构化会话、决策采纳/替代、提案复审/恢复、任务恢复和运行取消/重试。后端接入契约见 `mock/CONTRACT.md` 与 `mock/contract.ts`。开发引导仅从 main 动态载入 mock，生产构建剔除模拟内容。
