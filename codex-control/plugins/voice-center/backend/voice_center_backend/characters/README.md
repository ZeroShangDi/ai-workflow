# Voice Center 人设模块

这是语音插件内部可独立使用的 Python 模块，运行时仅依赖标准库。
内置 `elf-3`（森林精灵）和 `whale-3`（鲸鱼娘，默认）。人物资料与资源从现有
人物插件完整复制到本模块，保留原文和许可证，不需要另行安装或启动人物插件。

## 职责与边界

- 提供人物卡、persona、交流指引、通用音色参考、形象路径和动作组元数据。
- 提供人物列表、详情查询、当前选择和原子持久化。
- 读取资源时检查路径与符号链接，不能访问人物目录之外的文件。
- 仅生成交流风格指引，不创建任务、不授予权限、不控制播放或审批。
- 不保存千问音色 ID、情绪增强开关或供应商专用参数。千问映射和情感 / 环境策略仍由 `realtime_qwen/` 负责。

当前是模块准备阶段：尚未替换 `character.py` 的旧资源加载方式，未接入语音会话、
HTTP 或 MCP，也未删除独立的 `character-settings` 插件。现有会话行为不因模块新增而改变。

## 使用

在已安装的 Voice Center Python 后端中：

```python
from voice_center_backend.characters import CharacterSettings

characters = CharacterSettings()
catalog = characters.list()
current = characters.selected()
characters.select("whale-3")
instructions = characters.context()

setting = characters.selected()
audio_path = characters.resolve_asset(setting["id"], setting["voice"]["referenceAudio"])
```

| 方法 | 输入 | 输出 / 效果 |
| --- | --- | --- |
| `list(identifier=None)` | 可选人物 ID | defaultId、selectedId、人物摘要列表和指定人物详情；查看不改变选择 |
| `setting(identifier)` | 人物 ID | 完整详情的独立副本；格式合法但不存在的 ID 返回 None |
| `selected_id()` | 无 | 当前选择；缺少、损坏或失效的本地状态回退到默认人物 |
| `selected()` | 无 | 当前人物完整详情 |
| `select(identifier)` | 已存在的人物 ID | 原子保存选择并返回 selectedId/setting；无效 ID 不修改状态 |
| `context(identifier=None)` | 可选人物 ID | 带风格边界声明的 persona + 交流指引；不调用模型 |
| `resolve_asset(identifier, relative_path)` | 人物 ID、人物目录内相对路径 | 已存在文件的绝对 Path；越界、符号链接逃逸或缺失文件会报错 |

构造参数 `root` 可指定人物资源目录，`default_id` 可指定默认人物，
`selection_file` 可显式指定选择文件。默认配置如下：

| 设置 | 默认行为 |
| --- | --- |
| 人物资源 | 本目录 `resources/` |
| 默认人物 | `VOICE_CENTER_CHARACTER_DEFAULT_ID`，未配置时为 whale-3；不存在时回退到目录首个人物 |
| 状态文件 | `VOICE_CENTER_DATA_DIR/character-selection.json`；未配置数据目录时使用插件 `data/` |
| 写入方式 | 同目录临时文件 + 原子替换，文件权限 0600 |

读取列表和详情不会创建状态文件。模块拥有独立状态，不读写旧插件的 `data/selection.json`。

## 资源格式

沿用现有 `setting.json` schemaVersion=1，包含 id/name/card/documents/voice/images/actionGroups。
查询详情时附带 persona、skillInstructions、voice.referenceText；其余资源路径保持相对路径。
内置参考音频、文字、已有图片及 LICENSE 均随模块保存。空图片路径保留为空。
鲸鱼娘的 12 类状态动画已迁入 `resources/whale-3/animations/`，入口为其中的 `mapping.json`，
也可从人物详情的 `animations.mapping` 取得。每个状态单独一个目录，共 15 个原始 WebM 文件。
原 actionGroups 仍是完整动作元数据，并非全部动作都已迁入；实际动画以 mapping.json 为准。
播放器和事件接入尚未实现。

本次保留原人物资料内容，未改写人物文案或替换素材。
后续语音后端接入时，由各自适配器消费该模块的通用数据；选择变更如何应用到会话，
由会话层明确决定，本模块不隐式切换正在使用的模型、音色或动作。

## 验证

在语音插件目录执行 `npm test`，或在仓库根目录执行：

```sh
python3 plugins/voice-center/tests/characters.py
```

测试不需要音频服务、模型凭据或独立人物插件进程。
