# AI Workflow Framework

> 给 AI 加记忆、加流程、加自主推进能力 — Claude Code 之上的持久化执行层

## 安装

```bash
# npm（CLI + 插件）
npm install -g ai-workflow

# Claude Code 插件
/plugin install ai-workflow@claude-plugins-official

# 本地开发
git clone <repo> && cd ai-workflow/cc-control
npm install && npm link
claude --plugin-dir .
```

## 快速开始

```bash
awf init                 # 初始化项目，安装插件
awf plan "我的需求"       # 交互式规划 → .awf/state.json
awf run                  # 自主执行：遍历任务，逐阶段推进
awf attach               # 实时观看 AI 工作
```

## 架构

```
┌─ CLI (cli/awf.cjs) ────────────────────────────────┐
│  读取 state.json → 起环境（Session Server + tmux）   │
│  → 提交 run（POST /run/submit）→ 订阅事件/状态展示   │
│  编排（选任务/阶段/派发/落账）不在这里 —— 在宿主      │
└─────────────────────────────────────────────────────┘
         │ HTTP                          │ spawn
         ▼                              ▼
┌─ Session Server (server/) ─┐  ┌─ OneShot ───────────┐
│  /hook /send /cmd /status  │  │  claude -p (prompt) │
│  /run/submit /run/status   │  └─────────────────────┘
│  ready/busy 状态机         │
│  + run 宿主（server/run/）  │
└───────────────────────────┘
         │ tmux send-keys
         ▼
┌─ tmux session (Claude Code) ────────────────────────┐
│  加载 commands/ + skills/ + 3 个 MCP servers        │
│  AI 通过 awf_* tools 更新 state.json               │
└─────────────────────────────────────────────────────┘
```

## 目录

| 目录 | 说明 |
|------|------|
| `cli/` | CLI（7 命令：init / plan / run / plugin / server / open / attach） |
| `server/` | Session Server + run 宿主（web 面 / run 编排 / features 能力 / runtime 骨架 / shared 原语 / adapters cc 接入） |
| `plugin/` | 插件市场（三插件：core / decision / plugin-code — 命令 + 技能 + MCP + hooks） |
| `scripts/` | 开发脚本（bootstrap / render-config / lint / build / eval） |
| `tests/` | unit / integration / e2e（全真用例集）/ regression / fixtures |
| `web/` | 看板前端（React + Vite，构建产物落 `server/web/public`） |
| `docs/` | features（功能文档/测试用例）+ discuss + reuse + CHANGELOG |

## 开发

```bash
npm test          # 单元 + 集成测试
npm run lint      # 语法检查
npm run build     # 打包验证
npm run test:eval  # AI 质量评测（全真端到端）
```

## 许可证

MIT
