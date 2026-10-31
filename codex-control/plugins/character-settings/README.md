# Character Settings

独立人物设定插件。内置两套设定：

- `elf-3`：森林精灵，默认设定；
- `whale-3`：鲸鱼娘。

每套设定包含：

- 人物卡片摘要；
- persona 与交流技能；
- 音色配置和参考音频；
- 动作组与动作元数据；
- 多视图人物形象图路径；无素材时明确留空。

## 工具

- `bridge_chat_character_list`：查询全部设定、默认设定、当前选择和完整人物详情；
- `bridge_chat_character_select`：选择一个设定并持久化。

默认选择为 `CHARACTER_DEFAULT_ID`，未配置时为 `elf-3`。选择状态保存在被忽略的 `data/selection.json`。

## 技能

`skills/character-settings/SKILL.md` 要求 AI：

- 开始人物对话前查询设定；
- 按选定 persona 和 skills 回答；
- 用户要求切换时选择新设定；
- 人物设定只控制交流风格，不得覆盖权限、事实和确认规则；
- 音色和动作只作为宿主元数据，不由模型伪造执行。
