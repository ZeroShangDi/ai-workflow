# Codex Control Repository Instructions

## Codex Mobile Bridge 上游隔离

- `codex-mobile-bridge/` 是上游 Git submodule，默认视为只读依赖，尽量不改动其受版本控制的源码，保证上游完整性和后续更新能力。
- 插件管理、移动端补充能力、适配层、聚合 API 等定制实现，放在与 submodule 同级的自有后端目录中，通过公开 HTTP、进程或协议边界接入。
- 更新上游时保持 submodule 工作树干净；不得为了适配本仓库而重写、压缩或替换其 Git 历史。
- 只有确认问题来自上游缺陷且用户明确同意时，才允许修改 submodule 源码。此类修改必须独立记录、最小化，并优先向上游提交或维护可复用的补丁。

## Overall Architecture

- Canonical contracts live in `docs/architecture/`. Read them before changing any plugin, event, or dependency boundary.
- The target is two plugins plus one backend:
  - `plugins/voice-control/`: fully self-contained voice chat, page, ASR/TTS adapters, conversation provider, local notice ledger, playback acknowledgement, and public `open`/`close`/`tunnel` interfaces;
  - `plugins/bridge-control/`: fully independent task-control plugin with `voice-controller` and `work-reporter` profiles, backed directly by CMB public HTTP/SSE;
  - `bridge-hub/`: optional backend for future mobile App integration that independently depends on CMB and may consume Voice Control through its public `open`/`close`/`tunnel` interfaces.
- `voice-control` must not depend on `bridge-hub` or `bridge-control`.
- `bridge-control` must not depend on `bridge-hub` or `voice-control` implementation details.
- Both plugins access CMB only through public HTTP/SSE contracts; neither imports CMB source.
- `bridge-hub` is optional and must never become a prerequisite for either plugin pair working locally.
- Default task-event decoupling uses the local `~/.codex-control/events` JSONL contract. Voice playback state is persisted by `voice-control`, not Hub.
- All new public tools use the `bridge_chat_` prefix.

## Exposure and Safety

- `bridge-control` is not an ordinary globally exposed Codex plugin. It exposes two isolated internal profiles and must only be loaded by a trusted host for the dedicated control or work session.
- Work sessions may load only `work-reporter`; they must not create work, approve themselves, answer their own questions, or subscribe to control events.
- High-risk confirmation must be derived from the latest real user transcript and immutable interaction binding, never from a model-supplied boolean alone.
- Plugin installation does not imply configuration, health, pairing, subscription, or activation.
- Never accept or return plaintext credentials in tool arguments. Use environment variables or private local credential files.
- Plugins never own TTS playback acknowledgement. Only the voice host may emit spoken/interrupted acknowledgements after observed audio state.

## Verification

- Each project must run its own tests without requiring real provider credentials.
- Integration tests use mock CMB, mock ASR/TTS, and fake event consumers.
- Keep `codex-mobile-bridge/` clean; all CMB integration goes through public HTTP/SSE contracts.
