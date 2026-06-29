# ai-workflow CLI — WBS（工作分解结构）

```
1. 项目骨架 — 可正常编译的 TypeScript Node.js CLI 项目
   1.1 项目初始化 — 验收：package.json、tsconfig.json 就绪，npm install 成功
   1.2 插件清单 — 验收：.claude-plugin/plugin.json 符合 Claude Code 插件规范

2. 核心模块 — 与 Claude Code 插件系统交互的公共工具
   2.1 工具函数 — 验收：paths.ts 和 plugin.ts 导出的函数可单测
   2.2 install 命令 — 验收：执行后 claude plugin list 可见 ai-workflow 插件
   2.3 uninstall 命令 — 验收：执行后 claude plugin list 不可见，无残留文件

3. CLI 集成与验证 — 可执行的端到端产品
   3.1 CLI 入口 — 验收：ai-workflow install/uninstall 命令参数可正确路由
   3.2 端到端验证 — 验收：完整 install → 验证 → uninstall → 验证 流程通过
   3.3 代码质量 — 验收：pnpm lint 和 pnpm typecheck 零错误
```
