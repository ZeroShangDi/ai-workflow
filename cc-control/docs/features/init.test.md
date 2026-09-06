# awf init — 测试用例文档

> 对应需求文档：`docs/features/init.md`
> 源码文件：`src/cli/init.js`
> 测试文件：`tests/unit/init.test.js`

---

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 首次 init — 完整流程成功（.awf/ + 本地注入 + CLAUDE.md） | 正常流程 |
| 2 | 重复 init（.awf/ 已存在，无 --force） | 正常流程 |
| 3 | 重复 init + --force（补全缺失文件） | 正常流程 |
| 4 | tmux 未安装（warn 但不阻断） | 前置依赖 |
| 5 | claude 未安装（error 阻断） | 前置依赖 |
| 6 | CLAUDE.md 不存在 — 直接创建 | CLAUDE.md 注入 |
| 7 | CLAUDE.md 存在但无 awf 标记 — 追加注入 | CLAUDE.md 注入 |
| 8 | CLAUDE.md 存在且已有 awf 标记 — 跳过 | CLAUDE.md 注入 |
| 9 | CLAUDE.md 模板缺失 — warn 跳过 | 错误处理 |
| 10 | .awf/ 模板目录缺失 — fallback 创建空 .awf/ | 错误处理 |
| 11 | 插件模板缺失 — 本地注册 warn 不阻断 | 错误处理 |
| 12 | 版本处理禁用 — state.json 保留 {{VERSION}} 占位符 | 边界条件 |

> 说明：曾覆盖 `.plugins.json`（TC12/TC13）与 symlink 安装（TC15/TC16）的用例已删除。
> `.plugins.json` 机制已移除，全局安装改读 `plugin/settings.json` 的 `plugins` 字段（见 `cli-aux.test.js`）；
> init 不再处理符号链接安装（清理逻辑迁至全局安装 `installAllPlugins`）。

---

## 详细测试用例

### TC1: 首次 init — 完整流程成功

**前置条件**：目标目录无 `.awf/`、无 `CLAUDE.md`，模板目录与 `plugin/settings.json` 存在

**执行**：`initCommand({ force: false })`

**断言**：
- `.awf/` 目录被创建，包含 `state.json`、`README.md` 等模板文件
- `state.json` 中 `{{VERSION}}` 保留占位符（版本处理禁用）
- `state.json` 中 `{{TIMESTAMP}}` 被替换为 ISO 时间戳
- `.claude/settings.json` 被创建，包含 `enabledPlugins['ai-workflow-core@ai-workflow-dev']` 与 `enabledPlugins['ai-workflow-code@ai-workflow-dev']`，以及 `extraKnownMarketplaces`（path = `<pkg>/plugin` 解析后）
- **无** `claude plugin install` exec 调用（本地注入，非全局安装）
- `CLAUDE.md` 被创建，内容包含 `<!-- awf-rules start -->`
- 控制台输出包含 "初始化完成"
- 不发生 `process.exit(1)`

---

### TC2: 重复 init（.awf/ 已存在，无 --force）

**前置条件**：目标目录已有 `.awf/`，`force = false`

**执行**：`initCommand({ force: false })` × 2

**断言**：
- `.awf/` 内容未被修改（已有文件不变，缺失文件不补全）
- 日志输出 warn: "已存在，使用 --force 补全缺失文件"
- 进程正常退出

---

### TC3: 重复 init + --force（补全缺失文件）

**前置条件**：`.awf/` 已存在，但缺少 `bugs/` 目录，`force = true`

**执行**：先 `initCommand({ force: false })`，删除 `bugs/` 后再 `initCommand({ force: true })`

**断言**：
- 已有文件 `state.json` 保持不变（不被覆盖）
- 缺失的 `bugs/` 目录被创建，包含 `TEMPLATE.md`
- 日志输出 ok: "已补全缺失文件"

---

### TC4: tmux 未安装（warn 但不阻断）

**前置条件**：`execSync('command -v tmux')` 抛出异常，`command -v claude` 正常

**执行**：`initCommand({ force: false })`

**断言**：
- tmux 检查结果 status 为 `warn`，msg 包含 "brew install tmux"
- 不触发 `process.exit(1)`（因为只有 `error` 才阻断）
- 后续步骤正常执行（`.awf/` 仍被创建）

---

### TC5: claude 未安装（error 阻断）

**前置条件**：`execSync('command -v claude')` 抛出异常

**执行**：`initCommand({ force: false })`

**断言**：
- `process.exit(1)` 被调用（exit code 1）
- 不会执行插件注册、工作区初始化、CLAUDE.md 注入

---

### TC6: CLAUDE.md 不存在 — 直接创建

**前置条件**：项目目录无 `CLAUDE.md`，CLAUDE.md 模板文件存在

**执行**：`initCommand({ force: false })`

**断言**：
- `CLAUDE.md` 被创建，内容包含 `<!-- awf-rules start -->` 与 `awf 模式`

---

### TC7: CLAUDE.md 存在但无 awf 标记 — 追加注入

**前置条件**：`CLAUDE.md` 存在，内容为 `# My Project\n`，不含 `<!-- awf-rules start -->`

**执行**：`initCommand({ force: false })`

**断言**：
- 原有内容 `# My Project` 保留
- 末尾追加了模板内容（awf 规则块在原有内容之后）

---

### TC8: CLAUDE.md 存在且已有 awf 标记 — 跳过

**前置条件**：`CLAUDE.md` 存在，内容包含 `<!-- awf-rules start -->`

**执行**：`initCommand({ force: false })`

**断言**：
- 文件内容完全不变
- 日志输出 skip: "已包含 awf 规则，跳过注入"

---

### TC9: CLAUDE.md 模板缺失 — warn 跳过

**前置条件**：`src/templates/CLAUDE.md.template` 不存在

**执行**：`initCommand({ force: false })`

**断言**：
- 不创建 `CLAUDE.md`
- 日志输出 warn: "模板文件不存在，跳过注入"
- 不发生 `process.exit(1)`

---

### TC10: .awf/ 模板目录缺失 — fallback 创建空 .awf/

**前置条件**：`src/templates/awf/` 目录不存在（模拟缺失场景）

**执行**：`initCommand({ force: false })`

**断言**：
- fallback: `.awf/` 空目录被创建（`fs.mkdir`）
- `state.json` 不存在（模板缺失）
- 不阻断流程

---

### TC11: 插件模板缺失 — 本地注册 warn 不阻断

**前置条件**：`plugin/settings.json` 不存在

**执行**：`initCommand({ force: false })`

**断言**：
- `installProfile` 返回 `{written: false, error}`，`localPlugin` 输出 warn
- 后续步骤正常执行（`.awf/` 仍被创建）
- 不发生 `process.exit(1)`

---

### TC12: 版本处理禁用 — state.json 保留 {{VERSION}} 占位符

**前置条件**：版本处理在 `src/cli/init.js` 暂时禁用（`version = undefined`）

**执行**：`initCommand({ force: false })`

**断言**：
- `.awf/state.json` 中 `{{VERSION}}` 未被替换（占位符保留）

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `node:child_process.execSync` | `vi.mock` | 控制 `command -v tmux/claude` 返回 |
| `node:child_process.exec` | `vi.mock` | 断言本地注入**不**触发 `claude plugin install` |
| `node:fs/promises` | 临时目录 + 真实 fs | 文件 I/O 使用真实文件系统，临时目录中操作 |
| `paths.js` | `vi.mock` | 返回临时目录中的路径（`projectRoot` = FAKE_ROOT） |
| `version.js` | 已移除 | 版本处理禁用，不再 mock |

**测试夹具（FAKE_ROOT）**：在 `setupTemplates()` 中预置 `src/templates/awf/`、`src/templates/CLAUDE.md.template`、`plugin/core/mcp/awf-state/state.template.json`、`plugin/settings.json`，供 init 流程读取。
