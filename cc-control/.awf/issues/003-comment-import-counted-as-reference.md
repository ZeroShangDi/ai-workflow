---
id: "003"
title: "check-architecture 不变量①漏检：注释里的 import 被当成真引用"
status: resolved
labels: [bug, tooling]
assignee: null
milestone: null
priority: high
created: 2026-09-11
updated: 2026-09-12
deps: []
related: ["T1-114", "T3-009", "T3-009-F2", "T1-113"]
---

# check-architecture 不变量①漏检：注释里的 import 被当成真引用

> **处置（T1-120，2026-09-12 · resolved）**
> - **修复**：`scripts/check-architecture.mjs` 新增 `stripComments()`，`importedBy()` 先剥注释再扫。
>   块注释 → 等量空白（保换行，行号不错位）；行注释只剥**整行以 `//` 开头**的，不截断行尾注释
>   （字符串字面量里的 `//`，如 URL，会被行尾截断误伤 —— 按 issue 里的建议取整行口径）。
> - **单测**：`tests/unit/check-architecture.test.js` 新增 5 例 —— 整行注释 → 判零引用 / 块注释 → 判零引用 /
>   真引用与注释并存不误伤 / 行尾注释的**已知残留**（如实钉住当前行为）/ `stripComments` 保留换行数。
> - **连带面**：剥注释后首次暴露的零生产引用**实测只有 `src/lib/version.js` 一个**，与预期一致；
>   按 `.awf/decisions/runs/0.2.0-2026-09-10T14-21-09.jsonl` 的裁定落成**保留模块 + EXEMPTIONS 登记**
>   （`responsible: T4-001`，撤销时机写在该条目里），未删模块、未重注释、未加 glob。
> - **门禁**：`npm run check:arch` 在当前树 **EXIT 0**（豁免 5 条 = 零引用 1 + 依赖方向 4）。
> - **残留（已知且有意）**：`const a = 1; // require('…')` 这类**行尾**注释里的 import 仍被计为引用。
>   这是「只剥整行」换来的：截断行尾会误伤字符串里的 `//`。本仓库无该形态，行为已由单测固定。

## 现象

`scripts/check-architecture.mjs` 的不变量①（零生产引用）**在源码被注释掉的情况下仍然判为「已被引用」**，
于是「抽象建了没人用」这一失效模式可以从机器门禁下溜过去 —— 而这正是该不变量存在的唯一理由
（见 `.awf/issues/002-integration-has-no-task.md`）。

## 复现（2026-09-11 实测）

`src/lib/version.js` 的生产调用点在两处**都被注释掉**：

```js
// src/cli/init.js:5
// import { promptVersion } from '../lib/version.js'; // 版本处理暂时禁用
// src/cli/plan.js:2
// import { setupVersion } from '../lib/version.js'; // 版本处理暂时禁用
```

但：

```
$ node scripts/check-architecture.mjs
── ① 零生产引用模块：无          ← 应该报 src/lib/version.js
```

把注释剥离后再扫生产侧，`lib/version` **一次也没有被引用**。

## 根因

`REL_IMPORT` 正则做**纯文本扫描**，不区分代码与注释：

```js
const REL_IMPORT = /(?:require\(\s*|from\s+|import\(\s*)["'](\.[^"']+)["']/g;
```

注释行 `// import { x } from '../lib/version.js'` 里的 `from '…'` 同样命中，
于是该文件被登记进 `referenced` 集合，`zero-ref` 检查直接跳过它。

## 影响

- **假阴性**：被注释掉的接线点会让「零引用」检查失效；`version.js` 已实际漏检。
- 该假阴性只影响**零引用**判定（文件是否被采用）；依赖方向判定用的是同一份 `importedBy` 结果，
  因此注释掉的跨层 import 也可能被算成一条越界边（方向相反的错误：多报）。
- 严重度：**高**（它削弱的正是本模块唯一想要机器兜住的东西）。

## 修复方向

在 `importedBy()` 读文件后、跑正则前，先剥掉注释再扫：

1. 块注释 `/\*[\s\S]*?\*\//g` → 空白（保留换行以免影响行号类断言）；
2. 行注释 `^\s*\/\/.*$`（gm）→ 空白。

注意点：
- 不要把 `//` 之后的行尾注释也简单截断 —— 字符串字面量里出现 `//` 会误伤（如 URL）；本仓库暂无此形态，若要稳妥可只剥**整行以 `//` 开头**的注释，已足够覆盖本次的形态。
- 剥离后需为「注释里的 import」补一条**单测**（夹具：一个文件只有注释掉的 import → 目标文件应被判零引用），
  并与既有 37 例一并回归。
- 复核 `ENTRY_ALLOWLIST` / `EXEMPTIONS` 是否需要因此变化（预期不需要，但要跑一次看输出）。

## 决议

（待定）—— 归属建议：这是**验证工具自身的缺陷**，与 `T1-114`（把门禁从取证升级为可失败校验）同一血脉；
`T3-009` 第 3 轮已判 pass，故不在其修复范围内。建议作为独立小任务立项，或并入 `T1-113` 的 A/D 批次清单。
