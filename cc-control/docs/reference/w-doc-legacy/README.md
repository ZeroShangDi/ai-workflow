# w-doc 旧版参考

从 git 历史捞回的旧版 `w-doc` 自定义命令，以及合并三方后的新版草案，供重写参考。

本目录三个文件：

| 文件 | 内容 | 状态 |
|------|------|------|
| `w-doc.md` | 旧版命令原文（136 行，已统一术语为「功能级」） | 参考 |
| `w-doc.new.md` | 合并旧版 + 当前 w-doc + code-doc + 实际 docs/ 格式的新版草案 | **待审** |
| `README.md` | 本说明 | — |

若采纳 `w-doc.new.md`，用它替换 `plugin/plugin-code/commands/w-doc.md`。

## 来源

- 原始路径：`cc-plugins/commands/w-doc.md`（更早）→ `plugin_old/commands/w-doc.md`（最后保留处）
- 内容在各历史提交间一致（136 行），取 `ef80ed5:cc-control/plugin_old/commands/w-doc.md`
- 涉及提交（按时间）：`ece2f16` `9e1b1ee` `0416e31` `a7bd329` `ef80ed5` → `9e91ca5` 删除 plugin_old

## 与当前版差异

| 维度 | 旧版（本目录） | 当前版 `plugin/plugin-code/commands/w-doc.md` |
|------|----------------|-----------------------------------------------|
| 粒度 | 模块级 + 需求级（三件套：需求/测试/开发日志） | 单一层级，仅类型/目录/原则 |
| 参数 | `$ARGUMENTS` 路由（含 `/` → 需求级，支持 `--force`） | 无参数处理 |
| 文件命名 | 明确 `docs/<module>/<req-id>.{md,test.md,log.md}` 约定 | 无 |
| 模板 | 需求/测试（721 渐进式）/开发日志三套完整模板 | 无 |
| 路由 | 不存在→新建，存在→增量，`--force`→覆盖 | 无 |
| 撰写原则 | 5 条通用原则 | 3 条精简原则 |

## 提示

- 旧版引用的「原有的新建/更新流程（步骤一至五）」不在该文件内，属更早的配套流程文档，未随命令文件保留。
- `cc-plugins/skills/testdoc/SKILL.md`（测试回归文档）是另一功能，未纳入。
