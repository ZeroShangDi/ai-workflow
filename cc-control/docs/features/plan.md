# awf plan — 需求文档

## 功能描述

`awf plan` 启动 Claude Code 交互式规划会话，将用户需求转化为 `.awf/state.json` 中的结构化计划（WBS + 任务列表 + 里程碑）。

### 执行流程（3 步）

1. **版本确认** — 调用 `promptVersion()` 交互式选择版本号，写入 state.json
2. **构造 prompt** — 根据 `description` 和 `--resume` 拼接传递给 Claude 的完整指令
3. **spawn Claude** — 以 `stdio: 'inherit'` 模式启动 Claude Code 交互会话，用户直接参与规划

---

## 输入输出

### 输入

| 输入 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `description` | string | CLI 位置参数 | 用户的需求描述，如 `"搭建测试基础设施"` |
| `--resume` | CLI flag | `options.resume` | 恢复上次中断的规划会话 |
| `process.cwd()` | 路径 | 系统 | 目标项目根目录 |

### 输出

| 输出 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `state.json` | 文件 | `.awf/state.json` | 写入/更新版本号（`state.version = version`） |
| Claude Code 会话 | 交互进程 | 终端 | `stdio: 'inherit'`，用户直接操作 |

### spawn 参数

```js
spawn('claude', [
  '--settings', paths.ccSettings,    // .claude/settings.json
  '--dangerously-skip-permissions',  // 跳过权限提示
  prompt,                             // 构���后的 prompt
], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
```

### prompt 拼接规则

| 条件 | prompt |
|------|--------|
| `--resume` 为 true | `/ai-workflow:w-plan --resume 请恢复上次规划会话，继续对齐需求` |
| 有 description | `/ai-workflow:w-plan {description}` |
| 无 description 且非 resume | `/ai-workflow:w-plan 请开始需求规划` |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:child_process` (`spawn`) | 启动 Claude Code 子进程 |
| `./paths.js` (`getPaths`, `pluginCmd`) | 获取配置路径、生成带命名空间的命令 |
| `./logger.js` (`logger`) | 控制台输出（info/success/warn/error） |
| `./version-prompt.js` (`promptVersion`) | 交互式版本号选择 |
| `./state.js` (`loadState`, `saveState`) | 读写 `.awf/state.json` |
