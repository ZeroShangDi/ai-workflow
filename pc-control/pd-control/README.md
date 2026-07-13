# PD-Control

CLI tool for controlling a Parallels Desktop Windows VM via mouse, keyboard, and screen capture.

## Architecture

```
macOS (CLI)  ── HTTP/JSON ──►  Windows VM (Agent)
```

## Quick Start

### 1. Start the Agent in Windows VM

```powershell
pip install flask pyautogui mss
python agent.py
```

Optional — package to single exe:

```powershell
pip install pyinstaller
pyinstaller --onefile agent.py --name pd-agent
.\dist\pd-agent.exe
```

### 2. Install CLI on macOS

```bash
pip install -e .
```

### 3. Find the VM IP

Inside the VM, run `ipconfig` and look for the IPv4 address (usually `10.211.55.x`).

### 4. Use

```bash
export PD_HOST=10.211.55.3

pd-control ping
pd-control click 500 300
pd-control move 100 200
pd-control type "hello"
pd-control key enter
pd-control key c --ctrl
pd-control drag 100 200 300 400
pd-control shot -o screenshot.png
pd-control size
```

## Commands

| Command | Description |
|---------|-------------|
| `ping` | Test Agent connectivity |
| `click <x> <y>` | Mouse click at coordinates |
| `move <x> <y>` | Move mouse to coordinates |
| `drag <x1> <y1> <x2> <y2>` | Drag from start to end |
| `type <text>` | Type text via keyboard |
| `key <name>` | Press a key (--ctrl, --alt, --shift, --win) |
| `shot` | Capture screenshot |
| `size` | Get screen resolution |
