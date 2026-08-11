---
name: sys-rule-skill
description: >
  Skill lifecycle management — create, update, delete, organize, and audit skills.
  Enforces naming conventions, size limits, boundary rules, and anti-duplication.
  Trigger when the user asks to "create a skill", "manage skills", "organize skills",
  "audit skills", or when a new skill is about to be created.
---

# Skill 管理

管理 cc-control/skills/ 下所有 skill 的完整生命周期。

---

## 一、命名规则

### 三段式命名

```
{level}-{role}-{scope}

level:  sys    系统架构层 — 状态机、模块划分、数据结构
        flow   工作流程层 — 开发/审查/测试/提交/调试 阶段链条
        code   代码实践层 — 函数、命名、风格、组件设计

role:   spec   规范定义 — 描述一个东西是什么、怎么设计
        rule   行为规则 — 约束怎么做才对
        exec   执行工具 — 生成、转换、操作

scope:  具体的领域名称，用一个英文单词
```

### AWF 核心标识

AWF 工作流系统专用的 skill 前面加 `awf-` 前缀，四段：`awf-{level}-{role}-{scope}`

### 命名检查清单

| 检查项 | 规则 |
|--------|------|
| 前缀 | `core-` 通用（已省略），`awf-` 工作流核心 |
| level | 必须是 sys / flow / code 之一 |
| role | 必须是 spec / rule / exec 之一 |
| scope | 一个英文单词，不用缩写 |
| 唯一性 | 同格子内不能有两个 skill |

---

## 二、体积规则

| 规则 | 限制 |
|------|------|
| 单文件上限 | SKILL.md ≤ 300 行 |
| 超出时 | 优先拆分：能否按职责拆成两个独立的 skill？ |
| 不能拆分时 | 精简内容：有没有可以删而不影响意思的部分？ |
| 不能精简时 | 将纯参考资料（示例集、字典、附录）迁到 `docs/discuss/`，skill 中只保留规则和引用 |

```
处理顺序：拆分 → 精简 → 外迁（最后手段）
```

---

## 三、边界规则

### 两个 skill 不能说同一件事

| 情况 | 处理 |
|------|------|
| 两个 skill 有交集 | 合并为一个，或明确主从关系（主 skill 定义规则，从 skill 只引用） |
| 同一个格子已有 skill | 不能新建，必须合并到已有 skill 中 |
| 不确定是否有重叠 | 先列出两个 skill 的 description 和 scope，对比后决定 |

### 边界检查

```
检查项：
1. 新 skill 的 scope 是否和已有 skill 重叠？
2. 新 skill 的内容是否应该属于已有 skill 的范畴？
3. 新 skill 的 role 和已有 skill 是否重复？
```

---

## 四、生命周期规则

| 状态 | 条件 | 操作 |
|------|------|------|
| 活跃 | 近 3 个里程碑内被触发过 | 保持 |
| 待清理 | 连续 3 个里程碑未被触发 | 标记，和用户确认后删除 |
| 已废弃 | 功能已被其他 skill 覆盖 | 删除 |

---

## 五、Skill 文件结构

### 必须包含

```
skills/{name}/
└── SKILL.md        # 英文版（必须）
    SKILL.zh-CN.md  # 中文版（必须）
```

### SKILL.md 模板

```markdown
---
name: {level}-{role}-{scope}
description: >
  [一句话说明这个 skill 做什么]
  [触发条件：什么时候自动加载]
  [引用方：被哪些命令使用]
---

# [标题]

[内容按以下顺序组织：
 1. 核心定义
 2. 具体规则/流程
 3. 示例
 4. 边界和注意事项]
```

---

## 六、创建 Skill

### 流程

```
1. 确定 name — 按命名规则，先找格子
2. 写描述 — 一句话说清做什么 + 什么时候触发
3. 确定体积 — 预估内容量，超 300 行先想能不能拆成两个 skill
4. 写正文 — 按模板结构
5. 检查冲突 — 边界检查清单过一遍
6. 注册 — 更新 CLAUDE.md 的 Skills 表格
```

### 创建时自问

- 这个 skill 的格子是否已被占用？
- 如果没有这个 skill，AI 能正常工作吗？（能 → 不需要建）
- 这个 skill 的内容是否在已有 skill 中已经覆盖？
- 300 行够放吗？

---

## 七、更新 Skill

### 流程

```
1. 确认改动范围 — 只改一个 skill 还是影响多个
2. 改正文
3. 体积复查 — 改动后是否超 300 行
4. 同步 .zh-CN.md（如有）
5. 更新 CLAUDE.md（如 description 变化）
```

### 更新时注意

- 不要悄悄改变 scope（如果变了，可能意味着该拆成两个 skill）
- 增加内容时优先考虑精简已有内容，而非追加

---

## 八、删除 Skill

### 流程

```
1. 确认状态 — 是否连续 3 个里程碑未被触发
2. 确认无引用 — 检查所有命令和 skill 的引用
3. 备份 — 将内容迁到 docs/discuss/ 保留知识
4. 删除目录
5. 更新 CLAUDE.md
```

---

## 九、查找 Skill

### 查找方式

```
按 name:    ls skills/{name}/
按 level:   ls skills/{level}-*/
按 role:    ls skills/*-{role}-*/
按格子:    ls skills/{level}-{role}-{scope}/
按关键词:  grep -r "关键词" skills/*/SKILL.md
全列表:    ls -d skills/*/
```

### 列出所有 skill 的快速命令

```bash
for f in skills/*/SKILL.md; do
  name=$(head -4 "$f" | grep 'name:' | sed 's/name: //')
  lines=$(wc -l < "$f")
  echo "$name  (${lines}行)"
done
```

---

## 十、审计

### 审计清单

每完成一个里程碑时执行一次：

- [ ] 所有 skill 命名是否符合规范
- [ ] 有没有超过 300 行的 skill → 先拆，拆不了再精简，精简不了再外迁
- [ ] 有没有内容重叠的 skill
- [ ] 有没有连续 3 个里程碑未被触发的 skill
- [ ] 所有 skill 是否都在 CLAUDE.md 中注册
- [ ] zh-CN.md 是否和 SKILL.md 同步
- [ ] 有没有 description 过时的 skill

### 审计命令

```bash
echo "=== 体积检查 ===" && for f in skills/*/SKILL.md; do lines=$(wc -l < "$f"); if [ $lines -gt 300 ]; then echo "⚠ $(dirname $f | xargs basename): ${lines}行 (超300)"; fi; done && echo "=== 命名检查 ===" && for d in skills/*/; do name=$(basename "$d"); echo "$name" | grep -qE '^(awf-)?(sys|flow|code)-(spec|rule|exec)-[a-z]+$' || echo "⚠ $name 命名不规范"; done
```
