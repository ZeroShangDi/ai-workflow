# awf version-prompt — 需求文档

> 源码文件：`src/cli/version-prompt.js`

## 功能描述

`promptVersion(cwd)` 是一个交互式版本号选择器，在 `awf init` 和 `awf plan` 启动前被调用。它读取当前版本号，提供 +patch/+minor/+major 和自定义输入选项，返回用户确认的版本字符串。

---

## 交互流程

```
promptVersion(cwd)
  ├─ 1. 读取当前版本
  │    ├─ .awf/state.json 中有 version → 使用
  │    ├─ 否则读取 package.json 的 version
  │    └─ 都没有 → 默认 '0.0.1'
  │
  ├─ 2. 构造选项列表（semver 递增）
  │    ├─ 当前    {current}
  │    ├─ +patch  {major}.{minor}.{patch+1}
  │    ├─ +minor  {major}.{minor+1}.0
  │    ├─ +major  {major+1}.0.0
  │    └─ 自定义…  → 触发 input 提示
  │
  └─ 3. 返回版本号
```

### 选项示例

当前版本 `0.1.3`：

| 选项 | 值 |
|------|-----|
| 当前 0.1.3 | `"0.1.3"` |
| +patch 0.1.4 | `"0.1.4"` |
| +minor 0.2.0 | `"0.2.0"` |
| +major 1.0.0 | `"1.0.0"` |
| 自定义… | `"__custom__"` |

---

## 输入输出

### 输入

| 输入 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `cwd` | string | `process.cwd()` | 项目根目录，用于读取 state.json / package.json |

### 输出

- 返回 `string` — 用户确认的版本号

### 交互步骤

1. **select** — 展示 5 个选项，用户键盘选择
2. **input** (仅自定义) — 选择 `__custom__` 后，等待 50ms 再调 input（避免 select 残留 stdin 事件干扰），`prefill: 'editable'`

---

## 版本号读取优先级

```
.awf/state.json version
  → 如果是 '0.0.1'（初始默认值），继续尝试 package.json
  → 否则直接使用

package.json version
  → 如果 version ≠ '0.0.1'，覆盖当前值

最终 current = 0.0.1（无任何版本信息时）
```

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:fs/promises` | 读取 state.json、package.json |
| `node:path` | 拼接文件路径 |
| `@inquirer/prompts` (select, input) | 交互式 UI |
