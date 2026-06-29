---
name: testdoc
description: 根据「上次生成以来」src/ 目录的代码变动和提交者信息，自动生成/更新测试回归（提测）文档到 docs/feature/<分支名>.md。触发关键词：测试回归文档、提测文档、回归测试、/testdoc。
version: 2.0.0
argument-hint: "[无参数，自动按时间锚点取 src/ 增量]"
allowed-tools: [Read, Write, Bash]
---

# /testdoc — 生成/更新测试回归文档（按时间锚点 + 仅 src/）

只针对 **`src/` 目录的代码变动**生成给测试同学看的「测试回归文档」，写到
`docs/feature/<当前分支名最后一段>.md`。

范围不是单个 commit，而是**「上次生成文档以来到现在」的所有 src/ 改动**：
- 文档里维护一个机器可读的**时间锚点**（HTML 注释），记录上次生成时的 HEAD sha。
- 本次取 `<锚点 sha>..HEAD -- 'src/'` 的 diff，生成新版本块，并把锚点更新为当前 HEAD。
- 首次（无锚点/无文档）用 `git merge-base master HEAD`（分支分叉点）作为起点，覆盖整个分支的 src 改动。

已存在文档则**在顶部插入新版本块**（最新版本在最前），旧版本全部保留。

---

## 执行步骤

### 第 1 步：采集上下文 + 确定起始点

用 Bash 一次取齐。锚点格式固定为文档顶部一行：
`<!-- testdoc-anchor: last-sha=<短sha> last-time=<YYYY-MM-DD HH:MM> -->`

```bash
# 分支名 → 文件名（取最后一段，如 feature/0617-finance-agent → 0617-finance-agent）
BRANCH=$(git rev-parse --abbrev-ref HEAD)
NAME=$(echo "$BRANCH" | sed 's|.*/||')
DOC="docs/feature/$NAME.md"
echo "BRANCH=$BRANCH"
echo "NAME=$NAME"
echo "DOC=$DOC"

# 当前 HEAD 的 sha 与提交时间（写进版本块标题 + 更新锚点）
echo "HEAD_SHA=$(git rev-parse --short HEAD)"
echo "HEAD_TIME=$(git log -1 --date=format:'%Y-%m-%d %H:%M' --pretty='%ad')"

# 确定起始点 START 与 START_LABEL（人读的起点说明）
if [ -f "$DOC" ] && grep -q 'testdoc-anchor:' "$DOC"; then
  START=$(grep -oE 'last-sha=[0-9a-f]+' "$DOC" | head -1 | cut -d= -f2)
  START_LABEL=$(grep -oE 'last-time=[0-9-]+ [0-9:]+' "$DOC" | head -1 | cut -d= -f2-)
  echo "MODE=incremental"
elif [ -f "$DOC" ] && sed '/^<!--/,$d' "$DOC" | grep -qE '^## v[0-9]+\.[0-9]+'; then
  # 老文档：已有正式版本块但还没锚点 → 不重复生成，只补锚点（见第 5 步 MIGRATE 分支）
  echo "MODE=migrate"
else
  # 首次：无文档、或文档无锚点也无正式版本块 → 分支分叉点；极端取不到则回退空树
  START=$(git merge-base master HEAD 2>/dev/null)
  [ -z "$START" ] && START=$(git hash-object -t tree /dev/null)
  START_LABEL="分支起点"
  echo "MODE=first"
fi
echo "START=$START"
echo "START_LABEL=$START_LABEL"
[ -f "$DOC" ] && echo "DOC_EXISTS=yes" || echo "DOC_EXISTS=no"
```

**MODE=migrate 时直接跳到第 5 步的「补锚点」分支**：老文档的现有最高版本块已覆盖了「分支起点 ~ 现在」的 src 改动，再按 merge-base 生成只会得到与之大量重复的版本块。此时**不生成新版本块**，只给文档补上指向当前 HEAD 的锚点，让下次从这里增量。

### 第 2 步：取 src/ diff

```bash
echo "=== stat ==="
git diff --stat "$START"..HEAD -- 'src/'
echo "=== authors（范围内 src 改动的所有作者）==="
git log --format='%an' "$START"..HEAD -- 'src/' | sort -u
echo "=== commit 概要（帮助归类）==="
git log --format='%h %s' "$START"..HEAD -- 'src/'
echo "=== full diff ==="
git diff "$START"..HEAD -- 'src/'
```

- **若 stat 为空**（`<START>..HEAD` 之间 src/ 无任何改动）→ **不生成版本块**，打印
  `ℹ️ 自 <START_LABEL> 起 src/ 无改动，跳过文档生成。` 并结束。
- **diff 很大时**（stat 几百行以上）：只读 `--stat` + 用 Read 打开几个核心改动文件，不要把整个巨型 diff 灌进上下文。

### 第 3 步：确定版本号

- `DOC_EXISTS=no` → 新建文档，版本号 **v1.0**，标题概括用「首次提测」。
- `DOC_EXISTS=yes` → 用 Read 读全文。**解析版本号前必须先排除末尾注释模板**，否则模板里的占位 `## v1.x` 会被误判：

  ```bash
  # 截断掉第一个 <!-- 起的所有内容，只在正式正文里找最高版本号
  sed '/^<!--/,$d' "$DOC" | grep -oE '## v[0-9]+\.[0-9]+' | sort -V | tail -1
  ```

  新版本号 = 解析到的最高版本号**次版本号 +1**（v1.0 → v1.1 → v1.2…）。

### 第 4 步：生成版本块

严格套用下方「文档格式规范」。要点：
- **标题时间用当前 HEAD 的 `HEAD_TIME`**，格式严格 `YYYY-MM-DD HH:MM`，与一句话概括同行：
  `## v1.1 — 2026-06-24 16:30（修复 xxx + 优化 yyy）`
- 标题下第一行写**覆盖范围**：`> 覆盖范围：<START_LABEL> ~ <HEAD_TIME>（仅 src/）`
- 第二行写**提交者**（范围内多作者用顿号连接）：`> 提交者：A、B`
- 改动清单**只基于 src/ 的 diff**归类，不要把 docs/ 配置等非 src 改动写进来。

### 第 5 步：写文档（含维护锚点）

锚点行始终是文档**第二行**（标题下、说明行上方或下方均可，固定在顶部区域），格式：
`<!-- testdoc-anchor: last-sha=<HEAD_SHA> last-time=<HEAD_TIME> -->`

- **补锚点**（MODE=migrate，老文档已有版本块但无锚点）：**不生成新版本块**，用 Read 读全文 → 在文档标题下插入锚点行（值为当前 HEAD 的 sha/time）→ Write 覆盖，其余内容一字不改。然后输出 `🔖 已为老文档补上锚点（指向 <HEAD_SHA>），下次将从此处增量生成。` 并结束。
- **新建**（DOC_EXISTS=no）：用 Write 写完整文件（含顶部锚点 + 说明行 + v1.0 版本块 + 末尾注释模板，见下方范本），锚点的 sha/time 填**当前 HEAD**。
- **追加**（DOC_EXISTS=yes）：用 Read 读全文 →
  1. 把新版本块插入到**第一个旧版本块 `## v` 之前**（即顶部说明行/分隔线之后、最新旧版本块之前），使最新版本始终在最上方；新版本块与下方旧版本块之间用 `---` 分隔。
  2. **更新顶部锚点行**的 `last-sha`/`last-time` 为当前 HEAD 的值；
  3. 用 Write 整体覆盖。
  - **必须保留**：顶部说明行、所有旧版本块、版本块间 `---` 分隔线、末尾 `<!-- ... -->` 注释模板。
  - **只更新锚点这一行**，不要动其他历史内容；旧版本块之间的相对顺序保持不变。

### 第 6 步：输出结果

打印文件路径 + 新版本号 + 覆盖范围 + 锚点更新情况。例如：
`✅ 已更新 docs/feature/0617-finance-agent.md → v1.1（覆盖 2026-06-24 15:52 ~ 2026-06-25 10:30 的 src/ 改动），锚点已更新至 <sha>`

---

## 文档格式规范

每个版本块结构如下（顺序固定）：

```markdown
## v1.x — YYYY-MM-DD HH:MM（一句话概括本次改动）

> 覆盖范围：<上次时间或「分支起点」> ~ YYYY-MM-DD HH:MM（仅 src/）
> 提交者：张三、李四

### 本次主要做了什么

（1-2 句话，说清这次提测的核心内容）

### 改动清单

#### ✨ 新功能：xxx
（做了什么）

**影响范围**：（测试同学据此回归，写清楚哪些入口/场景受影响）

#### 🐛 修复：xxx
（什么 bug，根因可选）

**影响范围**：（受影响的功能点列表）

#### 🔧 优化：xxx
（重构/精简了什么，是否有功能变化）

**影响范围**：（涉及的场景）

### 风险点

| 优先级 | 风险 | 备注 |
|--------|------|------|
| 🔴 P0 | （核心功能/可能回归的大风险） | |
| 🟡 P1 | （边界场景） | |
| 🟢 P2 | （相对独立的小改动） | |
```

**改动归类规则**（按 src/ diff 推断 emoji 前缀）：
- ✨ 新功能：新增文件、新增能力
- 🐛 修复：commit message 含「fix/修复」，或改动是纠正错误行为
- 🔧 优化：重构、精简、代码搬移、无功能变化的清理

**影响范围是给测试同学的核心信息**，每一条改动都必须有，写清楚受影响的**用户可见入口和场景**，不要只写文件名。

**风险点表格**：从改动性质推断优先级。改了核心对话/请求链路 → P0；改了边界条件/缓存时机 → P1；新增独立功能/纯清理 → P2。无明显风险时表格可只留 P2 行或写「本次改动相对独立，无高风险项」。

---

## 新建文档的完整范本

文档不存在时，用 Write 写入如下结构（占位内容替换为实际生成内容；锚点 sha/time 填当前 HEAD）：

```markdown
# feature/<分支名> 提测记录

<!-- testdoc-anchor: last-sha=abc1234 last-time=2026-06-24 15:52 -->

> 每次提测或修复都新增一个版本块，旧版本保留。本文档仅追踪 src/ 目录的代码变动。

---

## v1.0 — YYYY-MM-DD HH:MM（首次提测）

> 覆盖范围：分支起点 ~ YYYY-MM-DD HH:MM（仅 src/）
> 提交者：张三、李四

### 本次主要做了什么

（……）

### 改动清单

（……每个改动一段，含影响范围）

### 风险点

| 优先级 | 风险 | 备注 |
|--------|------|------|
| 🔴 P0 | …… | |

---

<!--
## v1.x — YYYY-MM-DD HH:MM（修复/优化 xxx）

> 覆盖范围：xxx ~ xxx（仅 src/）
> 提交者：xxx

### 本次主要做了什么
（简述）

### 改动清单
（每个改动一段，说明做了什么 + 影响范围）

### 风险点
（如有）
-->
```

---

## 注意事项

- **只看 `src/` 目录的改动**，diff/log/stat 命令都要带 `-- 'src/'`，非 src（docs、配置、构建产物）一律不写进版本块。
- **范围由锚点决定**：增量模式取 `<锚点 sha>..HEAD`；首次取 `git merge-base master HEAD`，取不到回退空树。不要退化成「最近一次 commit」。
- **解析版本号前先 `sed '/^<!--/,$d'` 截断末尾模板**，否则会被占位 `## v1.x` 误判。
- **每次生成后必须更新顶部锚点行**为当前 HEAD 的 sha/time，否则下次会重复覆盖同一范围。
- 提交者从 `git log --format='%an' <范围> -- 'src/' | sort -u` 取全部作者，不要猜。
- 时间格式严格 `YYYY-MM-DD HH:MM`，且来自 commit 时间，不是当前系统时间。
- 追加时新版本块插到顶部（最新在前），务必保留所有旧版本块、末尾注释模板和版本块间分隔线，绝不整体重写丢历史；只改锚点那一行，旧版本块相对顺序不变。
- src diff 很大时优先 `--stat` + Read 核心文件，避免上下文爆掉。
- 文档是给测试同学的，语言通俗、聚焦「改了什么、要测什么、风险在哪」，不堆砌技术细节。
- 范围内 src/ 无改动时不生成空版本块，直接提示并结束。
