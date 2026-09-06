# awf version-prompt — 测试用例文档

> 对应需求文档：`docs/features/version-prompt.md`
> 源码文件：`src/cli/version-prompt.js`
> 测试文件：`tests/unit/version-prompt.test.js`

---

## 测试场景总览

| # | 场景 | 类别 |
|---|------|------|
| 1 | 读取 .awf/state.json 中的版本号 | 版本读取 |
| 2 | state.json 无 version 时回退到 package.json | 版本读取 |
| 3 | state.json version=0.0.1 时继续读取 package.json | 版本读取 |
| 4 | package.json 不存在 → 使用默认 0.0.1 | 版本读取 |
| 5 | 两者都不存在 → 使用 0.0.1 | 版本读取 |
| 6 | 用户选择"当前"→ 返回原版本号 | 交互 |
| 7 | 用户选择 +patch → 返回递增后的版本号 | 交互 |
| 8 | 用户选择 +minor → 返回递增后的版本号 | 交互 |
| 9 | 用户选择 +major → 返回递增后的版本号 | 交互 |
| 10 | 用户选择"自定义"→ 输入有效版本号 → 返回 | 交互 |
| 11 | 用户选择"自定义"→ 输入为空 → 返回当前版本 | 交互 |
| 12 | select 选项列表包含正确的 5 项 | 交互 |
| 13 | package.json 无效 JSON → 不抛异常，使用默认值 | 错误处理 |
| 14 | state.json 无效 JSON → 不抛异常，回退到 package.json | 错误处理 |
| 15 | 版本号格式校验：合法 semver | 格式 |
| 16 | 边界: 版本号各部分为 0 | 边界 |
| 17 | 边界: 大版本号 | 边界 |

---

## 详细测试用例

### TC1: 读取 state.json 中的版本号

**前置条件**：`.awf/state.json` 存在，`version = "0.2.0"`，`package.json` 存在 `version = "0.1.0"`

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- 返回 `"0.2.0"`（state.json 优先）
- 不读取 package.json（因为 version ≠ '0.0.1'）

---

### TC2: state.json 无 version 时回退到 package.json

**前置条件**：`.awf/state.json` 存在但不含 `version` 字段，`package.json` version = `"0.3.0"`

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- current 计算为 `"0.3.0"`
- select choices 的"当前"项值为 `"0.3.0"`

---

### TC3: state.json version=0.0.1 时继续读取 package.json

**前置条件**：`state.json.version = "0.0.1"`，`package.json.version = "1.2.3"`

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- current 被更新为 `"1.2.3"`（因为 0.0.1 是初始默认值，不信任它）
- 返回 `"1.2.3"`

---

### TC4: package.json 不存在 → 使用默认 0.0.1

**前置条件**：state.json 无 version，package.json 不存在

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- `fs.readFile('package.json')` 抛出 ENOENT → catch
- current 保持 `"0.0.1"`
- 返回 `"0.0.1"`

---

### TC5: 两者都不存在 → 使用 0.0.1

**前置条件**：state.json 和 package.json 都不存在

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- 两次 `fs.readFile` 都失败
- current = `"0.0.1"`
- 返回 `"0.0.1"`

---

### TC6: 用户选择"当前"→ 返回原版本号

**前置条件**：current = `"0.2.0"`

**执行**：mock `select` resolve 为 `"0.2.0"`（匹配当前选项值）

**断言**：
- 返回 `"0.2.0"`
- `input` 不被调用

---

### TC7: 用户选择 +patch → 返回递增版本号

**前置条件**：current = `"0.1.3"`

**执行**：mock `select` resolve 为 `"0.1.4"`

**断言**：
- 返回 `"0.1.4"`
- select choices 中 +patch 项值为 `"0.1.4"`（0.1.3 + patch: patch=3+1=4）

---

### TC8: 用户选择 +minor → 返回递增版本号

**前置条件**：current = `"0.1.3"`

**执行**：mock `select` resolve 为 `"0.2.0"`

**断言**：
- +minor 值为 `"0.2.0"`（minor=1+1=2, patch=0）
- 返回 `"0.2.0"`

---

### TC9: 用户选择 +major → 返回递增版本号

**前置条件**：current = `"0.1.3"`

**执行**：mock `select` resolve 为 `"1.0.0"`

**断言**：
- +major 值为 `"1.0.0"`（major=0+1=1, minor=0, patch=0）
- 返回 `"1.0.0"`

---

### TC10: 用户选择"自定义"→ 输入有效版本号

**前置条件**：current = `"0.1.3"`

**执行**：mock `select` resolve 为 `"__custom__"` → mock `input` resolve 为 `"2.0.0-beta"`

**断言**：
- `input` 被调用，参数包含 `default: "0.1.3"`, `prefill: 'editable'`
- 返回 `"2.0.0-beta"`

---

### TC11: 用户选择"自定义"→ 输入为空 → 返回当前版本

**前置条件**：current = `"0.1.3"`

**执行**：mock `select` resolve 为 `"__custom__"` → mock `input` resolve 为 `""` (trim 后为空)

**断言**：
- `const trimmed = custom.trim()` → `""`
- `if (trimmed)` → false
- 返回 current `"0.1.3"`

---

### TC12: select 选项列表包含正确的 5 项

**前置条件**：current = `"0.1.3"`

**执行**：`promptVersion(cwd)`，拦截 `select` 调用的 choices 参数

**断言**：
- choices 共 5 项
- 第 1 项：name 包含 "当前" 和 `"0.1.3"`，value = `"0.1.3"`
- 第 2 项：name 包含 "+patch" 和 `"0.1.4"`，value = `"0.1.4"`
- 第 3 项：name 包含 "+minor" 和 `"0.2.0"`，value = `"0.2.0"`
- 第 4 项：name 包含 "+major" 和 `"1.0.0"`，value = `"1.0.0"`
- 第 5 项：name 包含 "自定义"，value = `"__custom__"`，有 description

---

### TC13: package.json 无效 JSON → 不抛异常

**前置条件**：state.json 不存在，package.json 内容为 `{broken`

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- `JSON.parse` 抛异常 → catch
- current 保持默认 `"0.0.1"`
- 流程不中断
- 返回 `"0.0.1"`

---

### TC14: state.json 无效 JSON → 不抛异常，回退到 package.json

**前置条件**：state.json 内容为 `{broken`，package.json version = `"0.5.0"`

**执行**：`promptVersion(cwd)` + mock select 选"当前"

**断言**：
- state.json 读取失败 → catch，继续
- 回退读取 package.json → 成功 → current = `"0.5.0"`
- 返回 `"0.5.0"`

---

### TC15: 版本号格式 — semver 解析

**前置条件**：current = `"1"`（非法 semver，只有一个数字）

**执行**：`promptVersion(cwd)`，检查 `split('.').map(Number)` 结果

**断言**：
- `major = 1`, `minor = NaN`, `patch = NaN`
- +patch: `"1.NaN.NaN"`（语义上正确——代码不做格式校验）
- 这属于调用方责任，`promptVersion` 不负责校验 semver 合法性

---

### TC16: 边界: 版本号各部分为 0

**前置条件**：current = `"0.0.0"`

**执行**：检查构造的选项值

**断言**：
- +patch = `"0.0.1"`
- +minor = `"0.1.0"`
- +major = `"1.0.0"`

---

### TC17: 边界: 大版本号

**前置条件**：current = `"999.999.999"`

**执行**：检查构造的选项值

**断言**：
- +patch = `"999.999.1000"`（不限制 range）
- +minor = `"999.1000.0"`
- +major = `"1000.0.0"`

---

## Mock 策略

| 依赖 | Mock 方式 | 说明 |
|------|-----------|------|
| `@inquirer/prompts` (select, input) | `vi.mock` | 控制 `select` 返回的选项值、`input` 返回的用户输入 |
| `node:fs/promises` | `vi.mock` | 控制 state.json / package.json 的存在性和内容 |
| 定时器 (setTimeout 50ms) | `vi.useFakeTimers` 或忽略 | 自定义路径中 50ms 延迟可用 fake timers 跳过 |
