# PD-Control MVP Design

## 概述

PD-Control 是一个 CLI 工具，通过键鼠操作控制 Parallels Desktop 内的 Windows 11 虚拟机，最终目标是对接大模型解读视频流，实现 AI 驱动的完全电脑控制。

## 系统架构

```
macOS 终端                              Windows 11 VM (共享网络 :5000)
┌───────────────────────┐    HTTP      ┌──────────────────────────────┐
│  pd-control CLI        │ ──────────►  │  agent.exe (Flask, 常驻进程)  │
│  (typer, pd_control/)  │  JSON / PNG │                               │
│                        │ ◄────────── │  pyautogui → user32.SendInput│
│  Commands:             │             │  mss → GPU 帧缓冲截图          │
│    click / move / type │             │                               │
│    drag / shot / find  │             │  POST /click   POST /type     │
│    run (future)        │             │  POST /move    POST /drag     │
└───────────────────────┘             │  GET  /screen  GET  /health   │
                                       └──────────────────────────────┘
```

### 通信方式

VM 使用 Parallels 共享网络模式 (NAT)，无需切换网络配置。macOS 通过 `10.211.55.x` 网段直接 TCP 连接 Agent。延迟 < 5ms。

### 设计原则

- Agent 暴露 HTTP API，CLI 是薄封装 + UX 层
- 任务执行器 (V2) 是 CLI 的上层消费者，不影响 Agent 稳定性
- Agent 打包为单文件 exe（pyinstaller --onefile），免 Python 环境

## 文件结构

```
pd-control/
├── pd_control/
│   ├── __init__.py
│   ├── cli.py              # typer CLI 入口
│   └── client.py           # HTTP client，封装 Agent API 调用
├── agent/
│   ├── agent.py            # Windows Agent (Flask HTTP server)
│   └── requirements.txt    # Agent 侧依赖
├── pyproject.toml          # macOS CLI 依赖声明
└── README.md
```

## Agent API 设计

| 方法 | 路径 | 参数 | 返回 | 用途 |
|------|------|------|------|------|
| GET | `/ping` | — | `{"status":"ok"}` | 健康检查 |
| POST | `/click` | `x, y, button, clicks` | `{"ok":true}` | 鼠标点击 (button: left/right/middle) |
| POST | `/move` | `x, y, duration` | `{"ok":true}` | 鼠标移动 (duration 秒) |
| POST | `/drag` | `x1, y1, x2, y2, duration` | `{"ok":true}` | 鼠标拖拽 |
| POST | `/type` | `text` | `{"ok":true}` | 键盘输入文本 |
| POST | `/key` | `key, modifiers` | `{"ok":true}` | 单键/组合键 (key: enter/tab/esc..., modifiers: ctrl,alt,shift,win) |
| GET | `/screen` | — | PNG bytes | 截图 (mss, 5ms 级) |
| GET | `/size` | — | `{"w":1920,"h":1080}` | 获取屏幕分辨率 |

所有 POST 接口接收 JSON body，返回 JSON。`/screen` 直接返回 `image/png`。

## CLI 命令设计

```bash
# 配置（通过环境变量或 --host 参数）
export PD_HOST=10.211.55.3
export PD_PORT=5000

# 基础命令
pd-control ping                        # 测试连通性
pd-control click 500 300               # 左键点击
pd-control click 500 300 --button right # 右键点击
pd-control move 100 200                # 移动鼠标
pd-control type "hello world"          # 键盘输入
pd-control key enter                   # 按键
pd-control key c --ctrl                # Ctrl+C
pd-control drag 100 200 300 400        # 拖拽
pd-control shot                        # 截图，保存为 screenshot.png
pd-control size                        # 获取屏幕分辨率
```

## Agent 内层级

```
agent.py
├── Flask app (监听 0.0.0.0:5000)
├── /click  → pyautogui.click(x, y)
├── /move   → pyautogui.moveTo(x, y, duration)
├── /type   → pyautogui.typewrite(text)
├── /key    → pyautogui.hotkey(modifiers + key)
├── /drag   → pyautogui.drag(x2-x1, y2-y1, duration)
├── /screen → mss.mss().shot() → PNG bytes
├── /size   → pyautogui.size()
└── /ping   → {"status": "ok"}
```

## 关键技术选型

| 层 | 选型 | 原因 |
|----|------|------|
| 键鼠注入 | pyautogui | 封装 user32.dll SendInput，最广泛的 Python 键鼠库 |
| 截图 | mss | < 5ms 延迟，直接 GPU 帧缓冲，比 PIL.ImageGrab 快一个数量级 |
| 通信 | Flask HTTP | Agent 侧极简，任何 HTTP client 可调用 |
| CLI 框架 | typer | 自动生成 help，类型校验，一行一个命令 |
| CLI HTTP | requests | 稳定可靠的 HTTP client |
| 打包 | pyinstaller --onefile | Agent 打包为单个 exe，VM 内双击运行 |

## MVP 范围

**包含：**
- Agent 全部 8 个 API 端点
- CLI 全部 9 个命令
- `pyproject.toml` + `README.md`
- Agent pyinstaller 打包脚本

**不包含：**
- 静态脚本执行器 (V1.1)
- LLM 决策循环 (V1.2)
- 视频流优化 (V1.3)
- 图像模板匹配 (V1.1)
- 安全认证（本地开发，信任共享网络）
- 错误处理超过基础 try/except

## V2 演进路线

### V1.1 — 静态脚本执行器

- `pd-control run task.yaml` — 执行预定义的动作序列
- YAML 格式：动作列表 + wait + 简单条件
- `pd-control find template.png` — opencv 模板匹配找图并返回坐标

### V1.2 — LLM 决策循环

- 任务引擎：截图 → LLM 分析 → 决策 → 执行 → 截图 → ... 循环
- 支持目标描述 ("打开浏览器，搜索 xxx")
- 最大步骤限制、超时、终止条件

### V1.3 — 视频流优化

- dxcam 替代 mss（D3D 采集，< 1ms 延迟）
- MJPEG 或 WebSocket 推流
- 保持 HTTP 命令通道，视频走独立端口

## 工时估算

| 阶段 | 内容 | 时间 |
|------|------|------|
| MVP 开发 | CLI + Agent + 全部命令 | < 1 天 |
| Agent 打包验证 | pyinstaller + VM 内测试 | 1 小时 |
| 联调 | CLI → Agent 端到端 | 1 小时 |
| **MVP 产出** | **可用的 CLI 键鼠控制工具** | **< 1 天** |
| V1.1 | 脚本执行器 + 模板匹配 | + 1 天 |
| V1.2 | LLM 循环 | + 2-3 天 |
| V1.3 | 视频流 | + 3-5 天 |
