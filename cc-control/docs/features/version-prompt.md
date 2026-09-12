# awf version-prompt — 需求文档

> 源码文件：`src/lib/version.js`
> 测试文件：`tests/unit/version-prompt.test.js`

## 当前状态（2026-09-11 核实）

**该功能在生产路径上处于「已实现但未接线」状态，不生效。**

`src/cli/init.js:5` 与 `src/cli/plan.js:2` 的 import 与调用点**均被注释掉**，注释写明「版本处理暂时禁用」：

```js
// src/cli/init.js
// import { promptVersion } from '../lib/version.js'; // 版本处理暂时禁用

// src/cli/plan.js
// import { setupVersion } from '../lib/version.js'; // 版本处理暂时禁用
```

因此：`src/lib/version.js` 的**生产侧引用数为 0**，当前唯一消费方是 `tests/unit/version-prompt.test.js`。
`awf init` / `awf plan` 启动**不会**弹出此选择器，版本号改由 `package.json` / `.awf/state.json` 直接承载。

> 该状态已由结构门禁 `scripts/check-architecture.mjs` 的不变量①「零生产引用」覆盖。
> **2026-09-12（T1-120）**：门禁此前**漏检**此文件（扫描把注释里的 import 当成真引用，见
> `.awf/issues/003`），剥注释扫描后已如实检出；处理为**保留模块 + 登记豁免**（不是删除 —— 该能力
> 不在别处实现，两处调用点是人的有意关闭），豁免条目的 `responsible` 指向 `T4-001`，
> 撤销时机写在 `scripts/check-architecture.mjs` 的 `EXEMPTIONS` 里。
> 恢复接线时，除去掉两处注释外，还需同步更新 `init.md` / `plan.md` 的交互流程描述。

## 功能描述

`promptVersion(cwd)` 是一个交互式版本号选择器：读取当前版本号，提供 +patch/+minor/+major 和自定义输入选项，返回用户确认的版本字符串。
`setupVersion(cwd)` 是它的写回包装：拿到版本号后写入 `.awf/state.json` 的 `version` 字段并返回。

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

## 函数清单

| 函数 | 说明 | 位置 |
|------|------|------|
| `setupVersion(cwd)` | 调 `promptVersion` 拿版本号，写回 `.awf/state.json` 的 `version` 并返回 | `src/lib/version.js:15` |
| `promptVersion(cwd)` | 交互式选择版本号并返回字符串（不写盘） | `src/lib/version.js:25` |

---

## 依赖

| 模块 | 用途 |
|------|------|
| `node:fs/promises` | 读取 `.awf/state.json`、`package.json` |
| `node:path` | 拼接文件路径 |
| `@inquirer/prompts` (select, input) | 交互式 UI |
| `./state.js` | `setupVersion` 写回 state 用的 `loadState` / `saveState` |
