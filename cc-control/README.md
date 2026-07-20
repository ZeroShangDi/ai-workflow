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
┌─ CLI (bin/awf.js) ─────────────────────────────────┐
│  读取 state.json → 启动 Session Server + tmux       │
│  → 逐任务逐阶段发送 prompt → 轮询 ready/busy        │
└─────────────────────────────────────────────────────┘
         │ HTTP                          │ spawn
         ▼                              ▼
┌─ Session Server ──────────┐  ┌─ OneShot ───────────┐
│  /send /cmd /hook /status │  │  claude -p (prompt) │
│  ready/busy 状态机        │  └─────────────────────┘
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
| `bin/` | CLI 入口 |
| `commands/` | 14 个 slash commands |
| `skills/` | 10 个 skills（编码/设计/质量标准） |
| `prompts/run/` | 阶段 prompt 模板 |
| `tools/` | 3 个 MCP Server（state / session / oneshot） |
| `src/` | 内部实现（CLI + Server） |
| `scripts/` | 开发脚本 |
| `tests/` | 测试 + 评测 |
| `docs/` | 架构文档 |

## 开发

```bash
npm test          # 单元 + 集成测试
npm run lint      # 语法检查
npm run build     # 打包验证
npm run eval      # AI 质量评测
```

## 许可证

MIT
