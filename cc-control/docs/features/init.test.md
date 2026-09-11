# awf init — 测试用例

> 对应功能文档：docs/features/init.md
> 源码：`src/cli/init.js`（+ `src/cli/plugin.js`、`src/lib/profile.js`）
> 测试文件：`tests/unit/init.test.js`、`tests/regression/fullflow-regression.mjs`（`caseInit` 真机断言）

## 测试场景总览

### 单元测试（`tests/unit/init.test.js`）

| # | 场景 | 类别 |
|---|------|------|
| 1 | 首次 init 完整流程（.awf/ + 本地注册 + CLAUDE.md） | 正常流程 |
| 2 | 重复 init（.awf/ 已存在，无 --force） | 幂等 |
| 3 | 重复 init + `--force`（补全缺失） | 幂等 |
| 4 | tmux 未安装（warn 不阻断） | 前置依赖 |
| 5 | claude 未安装（error 阻断） | 前置依赖 |
| 6 | CLAUDE.md 不存在 → 创建 | CLAUDE.md 注入 |
| 7 | CLAUDE.md 存在无标记 → 追加 | CLAUDE.md 注入 |
| 8 | CLAUDE.md 已有标记 → 跳过 | CLAUDE.md 注入 |
| 9 | CLAUDE.md 模板缺失 → warn 跳过 | 错误处理 |
| 10 | README 模板缺失 → 骨架中断（.awf/ 空） | 错误处理 |
| 11 | 插件模板缺失 → 本地注册 warn 不阻断 | 错误处理 |
| 14 | 版本处理禁用 → state.json 保留 `{{VERSION}}` | 边界条件 |

> TC12/TC13/TC15/TC16 已删除：init 不再读 `.plugins.json`、不再处理符号链接安装（symlink 清理迁至全局安装 `installAllPlugins`，见 `cli-aux.test.js`）。

### 真机回归（`tests/regression/fullflow-regression.mjs` → `caseInit`）

纯文件断言，不需模型会话。`makeProject → awf init → 读产物 → 再跑一次 init 验幂等`，共 **14 条断言**：

| # | 断言 | 依据 |
|---|------|------|
| 1 | 三插件均注册（core/code/decision） | `settings.plugins` 中以 `ai-workflow-` 开头的项 == 3 |
| 2 | 三插件均 enabled | `settings.enabledPlugins[p] === true` |
| 3 | marketplace 指向仓库 plugin/ 且存在 | `extraKnownMarketplaces['ai-workflow-dev'].source.path` 存在 |
| 4 | 项目级 .mcp.json 三个 server | `awf-state` / `awf-session` / `awf-oneshot` 齐 |
| 5 | MCP server 均用存在的绝对路径 | `args[0]` 为绝对路径且 `fs.existsSync` |
| 6 | MCP server 均带 `AWF_PROJECT_ROOT=本项目` | 每个 server 的 `env.AWF_PROJECT_ROOT` |
| 7 | awf-session 指向带端口的 AWF_BASE | `/^http:\/\/127\.0\.0\.1:\d+$/` |
| 8 | `.awf` 骨架目录齐（7 项） | `bugs/issues/decisions/context/logs/reports/versions` 存在 |
| 9 | config.json 含 run.agents / run.decision / docs | `cfg.run.agents`、`typeof cfg.run.decision.enabled === 'boolean'`、`cfg.docs` |
| 10 | init 幂等：重跑后 settings 不变 | 前后 `JSON.stringify` 相等 |
| 11 | init 幂等：重跑后 .mcp.json 不变 | 前后 `JSON.stringify` 相等 |
| 12 | 未把插件装到仓库外 | `marketplace.source.source === 'directory'` |
| 13 | 仓库 plugin/ 在 marketplace 路径下 | `<path>/.claude-plugin/marketplace.json` 存在 |
| 14 | （记录）marketplace 路径 | 仅记录展示，恒 true |

## 详细测试用例

### TC1: 首次 init 完整流程

**前置条件**：目标目录无 `.awf/`、无 `CLAUDE.md`；模板目录（`awf-README.md` / `awf-config.json` / `architecture.md` / 非空 `CLAUDE.md.template`）、`plugin/settings.json`、`state.template.json` 均存在

**执行**：`initCommand({ force: false })`

**断言**：
- `.awf/` 目录被创建
- `state.json`：`{{VERSION}}` 保留（版本处理禁用），`{{TIMESTAMP}}` 被替换为 ISO 时间戳
- `.awf/context/architecture.md` 内容含 `Architecture Map`
- `.claude/settings.json` 含 `enabledPlugins['ai-workflow-core@...']`、`['ai-workflow-code@...']` 为 true，`extraKnownMarketplaces['ai-workflow-dev'].source.path === '<FAKE_ROOT>/plugin'`
- **无** `claude plugin install` exec 调用（本地注入）
- 控制台输出含 `✔ 初始化完成`
- `CLAUDE.md` 含 `<!-- awf-rules start -->`

---

### TC2: 重复 init（无 --force）→ 文件不变

**执行**：`initCommand({ force: false })` × 2

**断言**：第二次后 `state.json` 的 mtime **等于**第一次（未被触碰）

---

### TC3: 重复 init + --force → 补全缺失，已有不动

**前置条件**：先 init，删掉 `.awf/bugs/`，`force = true`

**断言**：
- `.awf/bugs/` 被重建（`isDirectory` true）
- `state.json` 内容与删除前完全一致（不被覆盖）

> 注：真机回归改校验「重跑后 settings/.mcp.json 不漂移」，本用例校验 `.awf/` 侧。

---

### TC4: tmux 未安装 → warn 不阻断

**前置条件**：`command -v tmux` 抛错，claude 正常

**断言**：
- 输出含 `未安装 — brew install tmux`
- 不调用 `process.exit(1)`
- `.awf/` 仍被创建（后续步骤继续）

---

### TC5: claude 未安装 → error 阻断

**前置条件**：`command -v claude` 抛错

**断言**：`process.exit(1)` 被调用

---

### TC6–TC8: CLAUDE.md 三态

| TC | 前置 | 断言 |
|----|------|------|
| TC6 | 无 CLAUDE.md | 被创建，含 `<!-- awf-rules start -->` 与 `awf 模式` |
| TC7 | CLAUDE.md = `# My Project\n` | 原内容保留，awf 规则块追加在其后（索引更靠后） |
| TC8 | CLAUDE.md 已含 `<!-- awf-rules start -->` | 文件内容**完全不变**（`toBe(orig)`） |

---

### TC9: CLAUDE.md 模板缺失 → warn 跳过

**前置条件**：删除 `src/templates/CLAUDE.md.template`

**断言**：不创建 `CLAUDE.md`；不调用 `process.exit(1)`

> 说明：本仓库模板已为 0 字节，真机 init 会走「内容为空 → skip」分支（不产出 CLAUDE.md），与 TC9 的「缺失 → 跳过」在结果上一致。

---

### TC10: README 模板缺失 → 骨架中断

**前置条件**：删除 `src/templates/awf-README.md`

**执行**：`initCommand({ force: false })`

**断言**：
- `.awf/` 目录仍被创建（`mkdir` 在复制之前）
- `state.json` **不存在**（`ensureSkeleton` 在 README 复制处抛错中止，未走到 `copyStateTemplate`）
- 不阻断流程

---

### TC11: 插件模板缺失 → 本地注册 warn 不阻断

**前置条件**：删除 `plugin/settings.json`

**断言**：`installProfile` 返回 `{written:false,error}` → `localPlugin` 输出 warn；`.awf/` 仍被创建；不调用 `process.exit(1)`

---

### TC14: 版本处理禁用 → 占位符保留

**执行**：`initCommand({ force: false })`

**断言**：`.awf/state.json` 仍含 `{{VERSION}}`

---

### 真机回归 caseInit

**执行**：`node src/awf.js init`（沙箱项目，隔离 env）→ 读 `.claude/settings.json` / `.mcp.json` / `.awf/config.json` → 再跑一次 init

**断言**：见「真机回归」14 条清单（含幂等与 marketplace 形态）。

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `node:child_process.execSync` | `vi.mock`（`tests/helpers/mock-child-process.js`） | 控制 `command -v tmux/claude` |
| `node:child_process.exec` | `vi.mock` | 断言本地注入**不**触发 `claude plugin install` |
| `node:fs/promises` | 真实 fs + 临时目录 | 文件 I/O 在 `mkdtemp` 目录中真实执行 |
| `src/lib/paths.js` | `vi.mock` | `projectRoot` 指向 `FAKE_ROOT`（模板与 plugin/settings.json 夹具所在） |
| `src/lib/version.js` | 未 mock | 版本处理已禁用 |

**夹具（FAKE_ROOT）**：`setupTemplates()` 预置 `src/templates/`（README/config/architecture/非空 CLAUDE.md.template）、`plugin/core/mcp/awf-state/state.template.json`、`plugin/settings.json`。
