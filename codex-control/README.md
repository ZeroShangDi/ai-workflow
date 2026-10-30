# Codex Control

Codex 功能开发与部署实验区。

## Codex Mobile Bridge

上游仓库：[`try2love/codex-mobile-bridge`](https://github.com/try2love/codex-mobile-bridge)

`codex-mobile-bridge/` 以 Git submodule 方式接入，保留独立提交历史，便于跟踪和更新上游版本。

```bash
# 首次初始化
git submodule update --init --recursive

# 更新到上游默认分支最新提交
git submodule update --remote --merge codex-control/codex-mobile-bridge

# 源码启动局域网网关
cd codex-control/codex-mobile-bridge
python3 -m venv .venv
.venv/bin/python -B scripts/test-backend.py --source-only
.venv/bin/python -B run.py --lan --port 18787
```

当前测试环境使用上游 `v2.1.6`（提交 `b6dde4d`）和独立端口 `18787`，不占用 `cc-control` 使用的 `8787`。

运行配置和首次登录凭据保存在 submodule 内被忽略的 `.local/` 目录。测试请使用项目内 `.venv`，避免系统安装的同名 `tests` 包遮蔽仓库测试目录。

## 维护边界

`codex-mobile-bridge/` 默认按上游只读依赖维护，尽量不修改其源码，确保可以持续拉取和升级。

插件管理、移动端扩展或协议适配等补充能力，优先在 `codex-control/` 下建立我们自己的后端实现，通过公开接口与 CMB 协作。只有确认属于上游缺陷且经过明确同意时，才修改 submodule 源码。

## Target Architecture

完整契约见：

- [总体架构](docs/architecture/README.md)
- [事件协议](docs/architecture/events.md)
- [工具协议](docs/architecture/tools.md)
- [开发计划](docs/architecture/development-plan.md)

目标形态是“两个可独立使用的插件 + 一个可选 App 后端”：

```text
codex-control/
├── plugins/voice-control/   # 自包含语音聊天、通知台账、open/close/tunnel
├── plugins/bridge-control/  # 直接依赖 CMB 的独立控制插件
└── bridge-hub/              # 后续 App 可选后端，不进入本地双插件主链路
```

依赖方向：

```text
bridge-control -> CMB public HTTP/SSE
bridge-control -> local task event files -> voice-control
bridge-hub -> CMB public HTTP/SSE                         # optional
bridge-hub -> voice-control public open/close/tunnel      # optional
```

`voice-control` 不依赖 `bridge-hub` 或 `bridge-control`。`bridge-control`
也不依赖 Hub；两者只通过 `~/.codex-control/events/` 中的有界事件文件解耦。

[`plugins/bridge-control`](plugins/bridge-control) 已拆为 `voice-controller` 与
`work-reporter` 两套隔离的内部控制面，并直接通过 CMB 公共 HTTP/SSE 工作。
旧的全量 MCP 原型不应继续保留在 `~/.codex` 中。

## Development

```bash
npm run check:boundaries   # 依赖方向与 CMB submodule 清洁检查
npm test                   # 依次运行三个项目并执行跨组件闭环测试
npm run test:integration   # 运行 Voice + Control + mock CMB 的直连闭环
npm run verify             # 边界检查 + 全部测试
```

运行时配置、日志和本地部署产物放在各项目的 `.local/`，不得提交。
Voice Control 必须把最终真实用户转写写入本地事件文件；Bridge Control 在确认、
审批和回答时重新读取该转写，不能由模型代填授权文本。播报状态由 Voice Control
自己的通知台账持久化，不写入 Hub。
