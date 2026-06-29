# ai-workflow CLI — 产品原型

## 交互流程

```
$ ai-workflow install

  ╔══════════════════════════════════════╗
  ║   ai-workflow CLI — 插件安装程序      ║
  ╚══════════════════════════════════════╝

  [1/4] 检测项目结构...
         ✓ 找到 12 个斜杠命令
         ✓ 找到 5 个技能
         ✓ 找到 1 个模板

  [2/4] 创建插件清单...
         ✓ 生成 .claude-plugin/plugin.json

  [3/4] 创建符号链接...
         ✓ ~/.claude/plugins/cache/ai-workflow/ai-workflow/1.0.0
           → /Users/xxx/MyProject/ai-workflow

  [4/4] 注册到 Claude Code...
         ✓ 写入 installed_plugins.json

  🎉 安装完成！重启 Claude Code 即可使用 /w-plan、/w-dev 等命令。


$ ai-workflow uninstall

  ╔══════════════════════════════════════╗
  ║   ai-workflow CLI — 插件卸载程序      ║
  ╚══════════════════════════════════════╝

  [1/2] 移除符号链接...
         ✓ 已删除 ~/.claude/plugins/cache/ai-workflow/

  [2/2] 从 Claude Code 注销...
         ✓ 已更新 installed_plugins.json

  ✓ 卸载完成！
```

## 架构设计

```
ai-workflow/                          # 项目根目录（= 插件目录）
├── .claude-plugin/
│   └── plugin.json                   # 插件清单（CLI 生成）
├── .claude/
│   ├── commands/                     # → 插件的 commands
│   │   ├── awf-run.md
│   │   ├── w-plan.md
│   │   ├── w-dev.md
│   │   ├── w-debug.md
│   │   ├── w-review.md
│   │   ├── w-test.md
│   │   ├── w-ui.md
│   │   ├── w-design.md
│   │   ├── w-doc.md
│   │   ├── w-commit.md
│   │   ├── w-finish.md
│   │   └── w-tree.md
│   ├── skills/                       # → 插件的 skills
│   │   ├── code-standards/
│   │   ├── design-standards/
│   │   ├── quality-standards/
│   │   ├── testdoc/
│   │   └── code-patterns/
│   └── templates/                    # → 插件的 templates
│       └── w-tree-template.html
├── src/                              # CLI 源码（新增）
│   ├── index.ts                      # 入口，解析 argv
│   ├── commands/
│   │   ├── install.ts                # install 命令实现
│   │   └── uninstall.ts              # uninstall 命令实现
│   └── utils/
│       ├── plugin.ts                 # 插件元数据
│       └── paths.ts                  # 路径解析
├── package.json                      # 含 "bin": { "ai-workflow": "./dist/index.js" }
├── tsconfig.json                     # 编译配置（新增）
└── CLAUDE.md                         # 项目文档
```

## 插件注入机制

```
安装前:
  ~/.claude/plugins/
  ├── cache/
  │   ├── claude-plugins-official/
  │   │   ├── superpowers/6.0.3/
  │   │   └── ...
  │   └── thedotmack/
  │       └── claude-mem/13.6.1/
  ├── installed_plugins.json          # 不包含 ai-workflow
  └── ...

安装后:
  ~/.claude/plugins/
  ├── cache/
  │   ├── claude-plugins-official/...
  │   ├── thedotmack/...
  │   └── ai-workflow/
  │       └── ai-workflow/
  │           └── 1.0.0 → /path/to/ai-workflow/   # 符号链接
  ├── installed_plugins.json          # 新增 ai-workflow@local 条目
  └── ...
```

## 插件清单 (.claude-plugin/plugin.json)

```json
{
  "name": "ai-workflow",
  "description": "AI 自治开发工作流：从需求规划到编码、审查、测试、提交的全流程自动化斜杠命令和技能集合",
  "version": "1.0.0",
  "author": {
    "name": "v-shangjunhao"
  },
  "keywords": ["workflow", "w-plan", "w-dev", "w-review", "autonomous", "ai"],
  "license": "MIT"
}
```
