# awf init — 测试用例文档

> 对应需求文档：`docs/features/init.md`
> 源码文件：`src/cli/init.js`
> 测试文件：`tests/unit/init.test.js`

---

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 首次 init — 完整流程成功 | 正常流程 |
| 2 | 重复 init（.awf/ 已存在，无 --force） | 正常流程 |
| 3 | 重复 init + --force（补全缺失文件） | 正常流程 |
| 4 | tmux 未安装（warn 但不阻断） | 前置依赖 |
| 5 | claude 未安装（error 阻断） | 前置依赖 |
| 6 | CLAUDE.md 不存在 — 直接创建 | CLAUDE.md 注入 |
| 7 | CLAUDE.md 存在但无 awf 标记 — 追加注入 | CLAUDE.md 注入 |
| 8 | CLAUDE.md 存在且已有 awf 标记 — 跳过 | CLAUDE.md 注入 |
| 9 | 模板目录不存在 — fallback 创建空 .awf/ | 错误处理 |
| 10 | 插件安装失败 — 报错但不阻断 | 错误处理 |
| 11 | .plugins.json 不存在 — 使用空列表 | 边界条件 |
| 12 | .plugins.json 格式非法 — 使用空列表 | 边界条件 |
| 13 | 已有有效 symlink — 跳过安装 | 插件 |
| 14 | 已有无效 symlink — 清理后重新安装 | 插件 |
| 15 | version 为空 — 不执行版本替换 | 边界条件 |

---

## 详细测试用例

### TC1: 首次 init — 完整流程成功

**前置条件**：目标目录无 `.awf/`、无 `CLAUDE.md`，模板目录存在

**执行**：`initCommand({ force: false })`

**断言**：
- `checkPrerequisites` 被调用，tmux 和 claude 检查结果均为 `ok`
- `.awf/` 目录被创建，包含 `state.json`、`README.md` 等模板文件
- `state.json` 中 `{{VERSION}}` 被替换为用户选择的版本号
- `state.json` 中 `{{TIMESTAMP}}` 被替换为 ISO 时间戳
- `CLAUDE.md` 被创建，内容包含 `<!-- awf-rules start -->`
- 插件安装过程被调用（`ai-workflow@ai-workflow-dev`）
- 控制台输出包含 "初始化完成"
- 进程退出码为 0（不发生 `process.exit(1)`）

---

### TC2: 重复 init（.awf/ 已存在，无 --force）

**前置条件**：目标目录已有 `.awf/`，`force = false`

**执行**：`initCommand({ force: false })`

**断言**：
- `.awf/` 内容未被修改（已有文件不变，缺失文件不补全）
- 日志输出 warn: "已存在，使用 --force 补全缺失文件"
- 插件安装步骤仍执行
- CLAUDE.md 注入步骤仍执行
- 进程正常退出

---

### TC3: 重复 init + --force（补全缺失文件）

**前置条件**：`.awf/` 已存在，但缺少 `bugs/` 目录，`force = true`

**执行**：`initCommand({ force: true })`

**断言**：
- 已有文件 `state.json` 保持不变（不被覆盖）
- 缺失的 `bugs/` 目录被创建，包含 `TEMPLATE.md`
- `.awf/state.json` 如不存在则创建，如已存在则跳过
- 日志输出 ok: "已补全缺失文件"

---

### TC4: tmux 未安装（warn 但不阻断）

**前置条件**：`execSync('command -v tmux')` 抛出异常，`command -v claude` 正常

**执行**：`initCommand({ force: false })`

**断言**：
- tmux 检查结果 status 为 `warn`，msg 包含 "brew install tmux"
- 不触发 `process.exit(1)`（因为只有 `error` 才阻断）
- 后续步骤正常执行
- 最终输出 "初始化完成"

---

### TC5: claude 未安装（error 阻断）

**前置条件**：`execSync('command -v claude')` 抛出异常

**执行**：`initCommand({ force: false })`

**断言**：
- claude 检查结果 status 为 `error`，msg 包含 "npm install -g @anthropic-ai/claude-code"
- `process.exit(1)` 被调用（exit code 1）
- 不会执行插件安装、工作区初始化、CLAUDE.md 注入

---

### TC6: CLAUDE.md 不存在 — 直接创建

**前置条件**：项目目录无 `CLAUDE.md`，CLAUDE.md 模板文件存在

**执行**：`initClaudeMd(projectRoot, cwd)`

**断言**：
- `CLAUDE.md` 被创建
- 文件内容 == 模板文件完整内容（包含 `<!-- awf-rules start -->` 到 `<!-- awf-rules end -->`）
- 日志输出 ok: "已创建（含 awf 规则）"

---

### TC7: CLAUDE.md 存在但无 awf 标记 — 追加注入

**前置条件**：`CLAUDE.md` 存在，内容为 `# My Project\n`，不含 `<!-- awf-rules start -->`

**执行**：`initClaudeMd(projectRoot, cwd)`

**断言**：
- 原有内容 `# My Project\n` 保留
- 末尾追加了模板内容（由空行分隔）
- 日志输出 ok: "已注入 awf 规则"

---

### TC8: CLAUDE.md 存在且已有 awf 标记 — 跳过

**前置条件**：`CLAUDE.md` 存在，内容包含 `<!-- awf-rules start -->`

**执行**：`initClaudeMd(projectRoot, cwd)`

**断言**：
- 文件内容完全不变
- 日志输出 skip: "已包含 awf 规则，跳过注入"

---

### TC9: 模板目录不存在 — fallback 创建空 .awf/

**前置条件**：`src/templates/awf/` 目录不存在（模拟缺失场景）

**执行**：`initWorkspace(paths, false, '0.1.0')`（首次，`.awf/` 不存在）

**断言**：
- `fs.cp` 抛出异常（模板不存在）
- fallback: `.awf/` 空目录被创建（`fs.mkdir`）
- 日志输出 warn: "模板缺失，已创建空目录"
- 不阻断流程，不抛出异常

---

### TC10: 插件安装失败 — 报错但不阻断

**前置条件**：`claude plugin install` 命令返回非零退出码

**执行**：`installAllPlugins(paths, [])`

**断言**：
- `execAsync` 抛出的错误被 catch
- 日志输出 error: "安装失败 — …"
- 后续插件继续尝试安装
- 不阻断流程

---

### TC11: .plugins.json 不存在 — 使用空列表

**前置条件**：项目目录无 `.plugins.json`

**执行**：`loadExtraPlugins(paths)`

**断言**：
- 返回空数组 `[]`
- 不抛出异常
- 仅安装默认插件 `ai-workflow@ai-workflow-dev`

---

### TC12: .plugins.json 格式非法 — 使用空列表

**前置条件**：`.plugins.json` 存在但内容为非法 JSON（如 `{invalid`）

**执行**：`loadExtraPlugins(paths)`

**断言**：
- `JSON.parse` 抛出异常，被 catch
- 返回空数组 `[]`
- 不阻断流程

---

### TC13: 已有有效 symlink — 跳过安装

**前置条件**：`~/.claude/plugins/ai-workflow` symlink 指向含 `plugin.json` 的目录，且 `installed_plugins.json` 中已有 `ai-workflow@ai-workflow-dev` 条目

**执行**：`installAllPlugins(paths, [])`

**断言**：
- symlink 不被删除
- `claude plugin install` 不被调用
- 日志输出 skip: "已安装"

---

### TC14: 已有无效 symlink — 清理后重新安装

**前置条件**：`~/.claude/plugins/ai-workflow` symlink 存在，但指向的目录不含 `plugin.json`

**执行**：`installAllPlugins(paths, [])`

**断言**：
- 旧 symlink 被 `fs.unlink` 删除
- `claude plugin marketplace add` 被调用
- `claude plugin install ai-workflow@ai-workflow-dev` 被调用
- 日志输出 ok: "已安装"

---

### TC15: version 为空 — 不执行版本替换

**前置条件**：`promptVersion` 返回空字符串或 undefined

**执行**：`initWorkspace(paths, false, '')`

**断言**：
- `replaceVersion` 被调用但不执行任何文件写入
- `.awf/` 目录正常创建（`{{VERSION}}` 未被替换）
- 不抛出异常

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `node:child_process.execSync` | `vi.mock` | 控制 `command -v tmux/claude` 和 `claude plugin *` 返回 |
| `node:child_process.exec` | `vi.mock` | 控制 `claude plugin install` 异步结果 |
| `node:fs/promises` | 临时目录 + 真实 fs | 文件 I/O 使用真实文件系统，临时目录中操作 |
| `version-prompt.js` | `vi.mock` | 返回固定版本号，避免交互式等待 |
| `paths.js` | `vi.mock` | 返回临时目录中的路径 |
