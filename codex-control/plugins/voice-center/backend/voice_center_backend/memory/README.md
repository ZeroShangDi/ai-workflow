# 外部记忆适配模块（结构准备）

本模块只负责接入边界，不实现记忆数据库、向量检索或事实提炼引擎。
当前没有指定外部供应商，也尚未注册到 PluginHost、HTTP、MCP 或聊天流水线。
因此当前正常聊天没有新增记忆网络调用、启动依赖或逐轮等待。

| 文件 | 职责 |
| --- | --- |
| contracts.py | 外部适配器协议、宿主绑定的用户身份、标准记忆条目 |
| service.py | 默认禁用、有限超时、失败降级、写入未知结果处理 |
| tools.py | 模型工具入口定义及参数校验，未发布到运行会话 |

`VOICE_CENTER_MEMORY_ENABLED` 默认为 false，超时配置为
`VOICE_CENTER_MEMORY_TIMEOUT_SECONDS`（默认 2 秒，最多 10 秒）。
即使开启，未注入具体 adapter 时仍返回 unconfigured，不暴露工具、不发送请求。
模块导入不读取凭据、不访问网络、不创建文件。

```python
from voice_center_backend.memory import MemoryIdentity, MemoryService, MemoryTools

# 身份必须来自可信宿主，不接受模型传入任意用户 ID。
service = MemoryService(MemoryIdentity(tenant="tenant-1", user="user-1"))
result = await service.search("之前的项目决定")  # 默认返回 disabled 和空 items
assert MemoryTools(service, source="host-turn-id").definitions() == []
```

后续供应商适配器实现 MemoryAdapter 的 search/remember/forget，负责服务端用户隔离、
鉴权、协议转换及幂等键。凭据从环境或私有文件读取，不进入工具参数。
无自动重试：检索失败返回空结果，聊天可继续；写入异常返回 unknown，不能说“已记住”或“已删除”。
调用方不能在结果未知时自动再次调用写工具。取消操作的异常继续向上传播，以停止当前工作。

预留工具：bridge_chat_memory_search、bridge_chat_memory_remember、bridge_chat_memory_forget。
用户身份和写入来源由宿主绑定，工具参数只含查询、内容或记忆 ID。
修改已有记忆可在外部适配器明确提供原子更新后扩展；目前不模拟先删后写的更新。

后续接入策略：
- 会话开始：检索少量稳定偏好，作为非指令的背景资料。
- 对话中：模型需要时检索；不默认让每一轮语音等待外部服务。
- 用户明确要求记住／忘记：调用保存／删除；成功回执后才确认。
- 原流水线与千问共用该服务；千问的上下文注入和 Function Calling 协议转换留在 realtime_qwen。
- 当前仅提供结构，没有实现自动档案预载、记忆提取、持久化或工具注册。

记忆不是人设、原始历史、任务状态或授权。来源不可信的记忆不能覆盖系统规则，
旧审批／旧确认不能授权当前任务。记忆按用户隔离，未来可增加人物作用域。
