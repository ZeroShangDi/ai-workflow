# CLI 重构 WBS

## 目标

每个 CLI 命令 3-5 行，每行一个函数调用。所有可复用逻辑归入 `src/lib/`，按功能域分目录。

## 当前状态

| 命令 | 行数 | 问题 |
|------|------|------|
| plan.js | 20 | ✅ 已完成 |
| attach.js | 15 | ✅ 基本整洁 |
| plugin.js | 52 | 可精简 |
| server.js | 95 | 可精简 |
| open.js | 96 | renderTree/openBrowser 应入 lib |
| init.js | 337 | 内联函数太多，重复 UI 代码 |
| run.js | 408 | 内联函数太多，待引用 lib 模块 |

重复代码：logSection/logStep/createSpinner/颜色常量 在 init.js 和 run.js 中完全重复。

---

## WBS

```
1. lib/ui        终端 UI 模块（提取重复代码）
├── 1.1 colors.js           # CYAN/GREEN/YELLOW/RED/DIM/RESET 常量
├── 1.2 log.js              # logSection(label), logStep(label, status, msg)
└── 1.3 spinner.js          # createSpinner(label) → { stop() }

2. lib/session    Session 通信模块（对齐 run.js 已有逻辑）
├── 2.1 client.js            # httpPost, httpPostJson, getStatus, sendText, sendCmd, sendRespond
├── 2.2 wait-ready.js        # waitForReady(onDecision) — 含决策检测
└── 2.3 starter.js           # ensureServer, ensureSession

3. lib/fs         文件系统模块（从 init.js 提取）
├── 3.1 merge-dir.js         # mergeMissing(src, dest) — 递归补缺失文件
├── 3.2 copy-template.js     # copyStateTemplate, copyIfMissing
└── 3.3 replace-vars.js      # replaceVersion, replaceInDir, replaceTimestamp

4. lib/init       初始化专用模块（从 init.js 提取）
├── 4.1 prerequisites.js     # checkPrerequisites() → { label, status, msg }[]
├── 4.2 plugin-installer.js  # loadExtraPlugins, installAllPlugins
├── 4.3 workspace.js         # initWorkspace(paths, force, version)
└── 4.4 claude-md.js         # initClaudeMd(projectRoot, cwd)

5. lib/browser.js             # openBrowser(target) — 跨平台打开浏览器（从 open.js 提取）

6. lib/tree-renderer.js       # renderTree(state) → html（从 open.js 提取）

7. 重构 CLI 命令
├── 7.1 init.js     # 精简为 5 步调用
├── 7.2 run.js      # 精简为 5 步调用，引用 lib/session
├── 7.3 server.js   # 精简，引用 lib/session/starter
├── 7.4 plugin.js   # 精简
├── 7.5 open.js     # 精简，引用 lib/browser + lib/tree-renderer
└── 7.6 attach.js   # 已整洁，无需改动
```

---

## 依赖关系

```
1.lib/ui ─────────────────────────────────────────┐
2.lib/session ────────────────────────────────────┤
3.lib/fs ──────→ 4.lib/init ──→ 7.1 init.js       │
                                                  ├─→ 全部 CLI 命令
5.lib/browser ──────→ 7.5 open.js ────────────────┤
6.lib/tree-renderer ─→ 7.5 open.js ───────────────┤
                                                  │
2.lib/session ──→ 7.2 run.js ─────────────────────┤
              ──→ 7.3 server.js ──────────────────┘
```

## 执行顺序

1. lib/ui（无依赖，最先）
2. lib/session（无依赖，并行）
3. lib/fs（无依赖，并行）
4. lib/init（依赖 lib/fs）
5. lib/browser + lib/tree-renderer（无依赖，并行）
6. 重构 CLI 命令（依赖以上全部 lib）
