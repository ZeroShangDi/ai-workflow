# Voice Control

`voice-control` 是独立安装、独立启动、也可远程部署的语音运行时。它提供语音会话、SSE 事件流、浏览器本地 ASR/TTS、最小宿主 SDK 和显式外部触发端口，不依赖 `bridge-hub`、`bridge-control` 或 CMB 源码。

当前交付是 Track A 第一版骨架，不是任务控制器。触发器不会创建、审批或停止任务，只把显式订阅的外部事件作为系统文本送入已打开的语音会话。

## 运行

要求 Node.js 20 或更高版本，无第三方运行时依赖。

```sh
cd codex-control/plugins/voice-control
npm test
npm start
```

默认地址为 `http://127.0.0.1:8791/`。可用环境变量：

- `VOICE_CONTROL_HOST`：监听地址，默认 `127.0.0.1`。
- `VOICE_CONTROL_PORT`：监听端口，默认 `8791`。
- `VOICE_CONTROL_DATA_DIR`：配置目录，默认插件内 `data/`。
- `VOICE_CONTROL_ALLOWED_ORIGINS`：逗号分隔的跨域来源，默认不允许跨域。

远程部署必须由部署层提供 HTTPS、身份认证、访问控制和网络策略。本插件本身不包含公网认证，也不应直接暴露在公网。

## 生命周期

```text
installed -> configured -> healthy -> paired -> subscribed -> active
```

- `installed`：插件文件、manifest 和入口存在。
- `configured`：运行时数据目录可用，触发配置可读取并通过校验。
- `healthy`：HTTP 服务可响应健康检查。
- `paired`：可信设备或宿主身份已建立。第一版返回 `false`，不伪造配对状态。
- `subscribed`：至少一个外部触发被配置并显式启用。
- `active`：至少存在一个打开的语音会话。

普通本地语音聊天不要求 `paired` 或 `subscribed`。任务控制能力在第一版始终不可用；安装、健康或订阅都不代表获得任务控制权限。

## 协议复用

事件语义参考 ai-market 现有语音实现，并收敛为宿主无关协议：

- `apps/voice-service/voice_service/pipeline.py` 与 `tests/test_work_bridge.py`：复用 `transcript/voice` 事件、活动状态名，以及“通知等空档、播放完成才 ack”的边界；
- `apps/call-phone-uni/src/modules/voice/index.ts`：复用宿主只接收有界 `user/assistant` transcript、语音窗口状态不泄漏到业务页面的做法；
- `apps/call-phone-uni/src/services/voice-work.ts` 与 `tests/voice-work.test.cjs`：保留“提案不等于写入、确认后提交、幂等键不变”的语义，但任务提交不进入本切片；
- `apps/call-phone-uni/src/services/voice-plugin-host.ts` 与 `tests/voice-plugin-host.test.cjs`：保留有界宿主请求和身份 fencing 的设计原则，不复制具体 Work 路由。

```json
{
  "type": "transcript",
  "role": "user",
  "text": "你好"
}
```

```json
{
  "type": "voice",
  "state": "speaking",
  "event": "bot_started",
  "message": null
}
```

```json
{
  "type": "activity",
  "state": "working"
}
```

外部后台通知必须携带稳定的 `noticeId`。页面只在浏览器实际播完或确认被打断后，
再写入宿主回执事件：

```json
{
  "type": "delivery",
  "noticeId": "delivery-123",
  "status": "spoken"
}
```

`status` 只允许 `spoken`、`interrupted`、`failed`。后台通知会等待当前聊天回答和
用户语音结束；用户开始说话时，正在播放的后台通知转为 `interrupted`，不会被
误记为已播报。该事件是语音宿主与 Hub 之间的连接点，不代表语音插件直接调用
Hub。

复用的状态名为 `listening`、`thinking`、`speaking`、`working`、`warning`、`error`、`idle`。转录角色为 `user`、`assistant`、`system`；前两种沿用 ai-market，`system` 是本插件用于会话和触发通知的明确扩展。

本插件额外为每个事件附加 `eventId`、`cursor`、`sessionId` 和 `createdAt`，但 SSE 业务负载仍保留上述紧凑语义。SSE 的 `id` 使用 cursor；浏览器自动重连时优先使用 `Last-Event-ID`，首次连接才使用查询参数 `after`。

没有直接搬入以下实现：

- Pipecat 的 VAD、帧管道、TTS 取消和上下文聚合；
- SmallWebRTC、STUN/TURN、UDP 媒体和移动端前台语音窗口；
- Android/uni-app 麦克风权限、原生事件桥和桌面悬浮窗；
- ai-market 的业务鉴权、WorkStore、Conversation/Transcript 存储和 `task_proposal` 提交流程；
- 与特定宿主绑定的 `plugin_host_request` 白名单代理。

不搬入的原因是这些能力依赖 Python/Pipecat/WebRTC 或移动原生运行时，或者与 ai-market 的账号、设备和业务授权耦合。本切片保留 HTTP/SSE、宿主事件和 `sdk/` 作为薄接口；后续可在不改变事件语义的前提下增加独立媒体服务或供应商适配器。

## HTTP API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查与生命周期状态 |
| `POST` | `/api/sessions` | 创建语音会话 |
| `GET` | `/api/sessions/:id` | 读取会话摘要 |
| `GET` | `/api/sessions/:id/events?after=0` | SSE 事件流 |
| `POST` | `/api/sessions/:id/events` | 宿主追加 `transcript`、`voice` 或 `activity` 事件 |
| `POST` | `/api/sessions/:id/close` | 关闭会话，可重复调用 |
| `GET` | `/api/config/triggers` | 读取触发配置 |
| `PUT` | `/api/config/triggers` | 整体替换触发配置 |
| `POST` | `/api/triggers/:id/dispatch` | 将已订阅的外部事件送入会话 |

页面只调用健康检查、会话创建/关闭、SSE 和单个事件追加接口。

## 外部触发

安装后的默认配置没有任何触发器：

```json
{
  "schemaVersion": 1,
  "triggers": []
}
```

只有显式写入启用项后，对应 trigger id 才能接收事件。主题也必须出现在该触发器的 `topics` 中：

```sh
curl -X PUT http://127.0.0.1:8791/api/config/triggers \
  -H 'Content-Type: application/json' \
  -d '{
    "schemaVersion": 1,
    "triggers": [{
      "id": "trusted-host-events",
      "enabled": true,
      "topics": ["task.completed", "task.failed"],
      "description": "由可信宿主显式配置"
    }]
  }'
```

```sh
curl -X POST http://127.0.0.1:8791/api/triggers/trusted-host-events/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "vcs_...",
    "topic": "task.completed",
    "eventId": "evt-from-host-1",
    "noticeId": "delivery-from-host-1",
    "text": "后台任务已完成。"
  }'
```

触发器只产出 `type: "trigger"` 的系统文本事件，不代理任意 URL，也不执行任务操作。未配置、未启用或主题未订阅时返回 `409`。

## 页面与 SDK

`web/` 使用同源 HTTP/SSE。页面检测浏览器 Web Speech API：

- 可用时，最终识别结果作为 `transcript(role=user)` 写入会话；助手/系统文本事件由浏览器 `speechSynthesis` 播报。
- 不可用时，能力状态明确显示不可用，并保留文字输入；不会使用模拟识别结果或伪造播报。
- 浏览器本地播报不是生产 TTS 证明。替换为远程 TTS 或 WebRTC 主机时，应继续由主机观察实际播放状态，插件不代替主机发送播放完成回执。

```js
import { createVoiceClient } from './sdk/index.mjs';

const client = createVoiceClient({ baseUrl: 'http://127.0.0.1:8791' });
const session = await client.createSession({ title: '本地测试' });
const stream = await client.subscribe(session.id, {
  after: '0',
  onEvent(event) {
    console.log(event.type, event);
  },
});

await client.closeSession(session.id);
stream.close();
```

SDK 只依赖标准 `fetch`、`AbortSignal`、`ReadableStream` 和 `TextDecoder`，不导入 Hub、Control 或 CMB。

## 验证

```sh
npm test
```

测试使用 `node:test`、内存事件流和临时配置目录，不需要真实麦克风、外部网络、语音厂商密钥或 ai-market 服务。
