# ai-workflow CLI — 任务清单

| # | 任务 | 对应 WBS | 依赖 | 预估 |
|---|------|---------|------|------|
| 1 | 初始化 Node.js + TypeScript 项目骨架（package.json、tsconfig.json、.gitignore） | 1.1 | - | - |
| 2 | 创建 `.claude-plugin/plugin.json` 插件清单 | 1.2 | - | [P] |
| 3 | 实现 `src/utils/paths.ts` — 路径解析工具（插件目录、缓存路径等） | 2.1 | 1 | - |
| 4 | 实现 `src/utils/plugin.ts` — 插件元数据操作（读取/写入 installed_plugins.json） | 2.1 | 1 | - |
| 5 | 实现 `src/commands/install.ts` — install 命令（检测→清单→符号链接→注册） | 2.2 | 3, 4 | - |
| 6 | 实现 `src/commands/uninstall.ts` — uninstall 命令（移除符号链接→注销） | 2.3 | 3, 4 | - |
| 7 | 实现 `src/index.ts` — CLI 入口（参数解析、命令路由） | 3.1 | 5, 6 | - |
| 8 | 编译并本地测试 install + uninstall 流程 | 3.2 | 7 | - |
| 9 | 代码质量检查（lint + typecheck）并修复问题 | 3.3 | 7 | - |
