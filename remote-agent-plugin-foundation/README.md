# 远端 Agent 插件开发模板

默认栈：Node.js 24 + TypeScript、Hono、Better Auth、官方 MCP SDK、SQLite、原生 HTML/JavaScript。复制后是独立项目，不依赖模板目录、共享后端或模板作者账号。笔记是可替换的示例业务。

## 新建一个插件

在已安装依赖的模板目录执行：

```sh
npm run create -- /absolute/path/my-plugin my-plugin
```

目标目录必须不存在。脚本复制源码和锁文件，设置插件名称，生成新的私有 `.env`，清空 Codex 平台应用关联。不会复制 node_modules、数据库、凭据、Git 历史、构建产物或已安装插件。

进入新项目：

```sh
npm ci
npm run check
npm run dev
```

默认访问 http://localhost:8787。没有预置账号，在页面注册自己的试用账号即可。

手动复制模板或从压缩包建立项目时，先 `npm ci`，再运行 `npm run init -- --name my-plugin`。不传名称的 `npm run init` 只创建缺失的 `.env`，不会覆盖已有私有配置。传名称表示重置产品元数据和本地 marketplace，请在新项目初始化时使用。

## 开发时修改哪里

```text
src/
  server/notes/     示例业务契约、规则、数据表、查询与远端客户端
  server/index.ts   业务 HTTP 路由
  mcp/index.ts      业务 MCP 工具与身份绑定
  web/             插件自己的页面、样式与业务交互
  app.ts           装配 API、MCP、网页和公共能力
  main.ts          服务端入口
  cli.ts           本地客户端入口
foundation/
  auth/            账号、OAuth、设备码、授权连接管理
  server/          HTTP、安全头、输入限额、错误、日志、启动停止
  mcp/             每请求隔离的 MCP HTTP 传输及授权发现
  client/          固定源 API、设备码登录、私有凭据
  storage/         SQLite 连接、事务迁移执行
  web/             通用账号和授权页面片段、交互
  hosts/           各宿主清单生成器
  scripts/         初始化、独立复制、构建、打包
  contracts/       基础能力公开契约
skills/            唯一维护的业务 Skill 源码
plugin.config.ts   名称、版本、地址、权限、平台注册 ID
```

业务数据表、校验、规则属于 `src/server/`。基础层不导入 `src/`，业务通过公开入口使用基础能力。新增业务功能可按 notes 的方式就近组织；不要求为每个功能建立独立 npm 包。

根目录保留 package.json、锁文件、TypeScript、Docker、环境示例、开发规范等标准入口；交付包根目录遵循各宿主要求，不迁移进 foundation。

公共账号页面使用约定的 DOM 插槽（如 account、workspace、status、devices），业务页面由 `initializeAccount` 的登录/退出回调衔接。Web 不读取数据库和本地凭据，通过 HTTP 调用服务端。

## 运行与验证

```sh
npm run build
npm start
npm run cli -- login
npm run cli -- status
npm run cli -- serve
npm run cli -- logout
```

开发和启动命令自动加载 `.env`；环境变量可覆盖其中的值。`APP_ORIGIN` 必须与用户访问的来源一致，远程地址必须 HTTPS。`AUTH_SECRET` 由初始化脚本生成，`DATA_DIR` 默认 `.data`。本地 CLI 凭据按插件名称和服务 origin 隔离，文件权限为 0600。

`npm run check` 执行类型、测试和格式检查。测试不需要真实账号、网络服务或厂商密钥。构建会携带网页静态资源，不依赖源模板目录。

## 生成宿主交付包

```sh
npm run package:plugin -- --host codex
npm run package:plugin -- --host workbuddy --origin https://your-service.example
npm run package:plugin -- --host doubao --origin https://your-service.example
npm run package:plugin -- --host dsh
```

结果在 `artifacts/<host>/`；只修改源码，不能手工维护生成结果。Skill 中的 `{{APP_ORIGIN}}`、`{{PLUGIN_NAME}}` 会在打包时替换。打包不部署、不注册、不自动安装宿主插件。

- Codex：配置 `hosts.codex.appId` 时生成 `.app.json` 关联；留空时生成直接 HTTP MCP。直接 MCP 并不保证插件详情页出现平台账号关联按钮。新项目的平台注册 ID 必须自行取得，不能复用模板示例的注册关系。
- WorkBuddy、豆包：提供按已查官方规范生成的配置示例；尚未完成实机验收、完整平台准入或商店提审，不能宣称已适配可发布。
- DSH：生成 stdio 配置说明和条目，依赖本机项目的编译产物，先用 CLI 完成设备码登录。不是自包含的 DSH 安装包，需按宿主版本确认导入方式。

Codex 本地市场配置位于 `.agents/plugins/marketplace.json`，指向生成后的 artifacts/codex。先生成包再通过宿主的安装方式安装。新插件不需要与此模板保持运行时连接。

## 当前基础能力与边界

详见 [公共能力检查](docs/template-audit.md) 和 [宿主调研](docs/host-compatibility.md)。当前目标是开发与受控试用：未提供邮件验证/找回密码、生产备份、多副本部署、计费、任务队列或移动端外壳。

Dockerfile 提供单实例入口，要求注入 AUTH_SECRET、APP_ORIGIN，持久化 `/app/.data`，生产 HTTPS 由反向代理提供。容器构建未实测。公开部署前还需关闭或限制试用注册、确定 DCR 策略、配置可信代理地址及持久化备份。

普通网页登录不计入 Agent 连接；当前管理页统计 OAuth 授权记录，不代表物理电脑数量，不覆盖旧设备码 CLI；OAuth 授权仍受底层登录会话生命周期约束。
