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

目标形态是“两插件 + 一后端”：

```text
codex-control/
├── plugins/voice-control/   # 独立语音插件：页面、语音服务、SDK、触发器
├── plugins/bridge-control/  # 内部控制插件：voice-controller + work-reporter
└── bridge-hub/              # 依赖 CMB 的后端：事件、订阅、配对、收件箱、适配器
```

依赖方向：

```text
bridge-hub -> CMB
bridge-hub -> bridge-control contracts
bridge-hub -. optional public SDK/API .-> voice-control
```

`voice-control` 不依赖 `bridge-hub` 或 `bridge-control`。安装不等于可用，必须完成配置、健康检查、配对和事件订阅。

当前 [`plugins/bridge-control`](plugins/bridge-control) 的五工具 MCP 版本是本地集成原型，不会被当作最终普通 Codex 插件发布。
