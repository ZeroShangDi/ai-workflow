# PD-Control MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool + Windows Agent that enables controlling a Parallels Desktop Windows 11 VM via mouse, keyboard, and screen capture over HTTP.

**Architecture:** macOS CLI (typer) sends HTTP requests over Parallels shared network to a Flask server running inside the Windows VM. The Agent uses pyautogui (user32.dll SendInput) for input injection and mss (GPU frame buffer) for screenshots. The Agent is packaged as a single-file exe via pyinstaller.

**Tech Stack:** Python 3.9+, typer, requests, Flask, pyautogui, mss, pyinstaller

**Files created (7):**
- `pyproject.toml` — macOS CLI project config
- `agent/requirements.txt` — Agent dependencies
- `agent/agent.py` — Windows Flask server (8 endpoints)
- `pd_control/__init__.py` — package init
- `pd_control/client.py` — HTTP client library
- `pd_control/cli.py` — typer CLI entry point
- `README.md` — usage documentation

---

### Task 1: Project scaffolding

**Files:**
- Create: `pyproject.toml`
- Create: `pd_control/__init__.py`
- Create: `agent/requirements.txt`

- [ ] **Step 1: Create pyproject.toml**

```toml
[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.build_meta"

[project]
name = "pd-control"
version = "0.1.0"
description = "CLI tool for controlling Parallels Desktop Windows VM via mouse, keyboard, and screen capture"
requires-python = ">=3.9"
dependencies = [
    "typer>=0.9",
    "requests>=2.28",
]

[project.scripts]
pd-control = "pd_control.cli:main"

[tool.setuptools.packages.find]
include = ["pd_control*"]
```

- [ ] **Step 2: Create pd_control/__init__.py**

```python
"""PD-Control — Control Parallels Desktop Windows VM from macOS terminal."""
```

- [ ] **Step 3: Create agent/requirements.txt**

```
flask>=3.0
pyautogui>=0.9.54
mss>=9.0
```

- [ ] **Step 4: Install macOS CLI in dev mode and verify**

```bash
pip install -e .
```

Expected: installs pd-control with typer + requests. Verify with:

```bash
pd-control --help
```

Expected: shows CLI help with ping/click/move/drag/type/key/shot/size commands.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml pd_control/__init__.py agent/requirements.txt
git commit -m "feat: scaffold pd-control project structure"
```

---

### Task 2: Windows Agent (Flask server)

**Files:**
- Create: `agent/agent.py`

**Note:** This file runs inside the Windows VM. It is NOT part of the macOS pip package.

- [ ] **Step 1: Write agent/agent.py**

```python
"""PD-Control Agent — Runs inside Windows VM.
Exposes HTTP API for mouse, keyboard, and screen control.
Start with: python agent.py
Package to exe: pyinstaller --onefile agent.py
"""
import io
from flask import Flask, request, jsonify, send_file
import pyautogui
import mss

app = Flask(__name__)

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.01


@app.get("/ping")
def ping():
    return jsonify({"status": "ok"})


@app.post("/click")
def click():
    data = request.get_json()
    pyautogui.click(
        x=data["x"],
        y=data["y"],
        button=data.get("button", "left"),
        clicks=data.get("clicks", 1),
    )
    return jsonify({"ok": True})


@app.post("/move")
def move():
    data = request.get_json()
    pyautogui.moveTo(
        x=data["x"],
        y=data["y"],
        duration=data.get("duration", 0.2),
    )
    return jsonify({"ok": True})


@app.post("/drag")
def drag():
    data = request.get_json()
    pyautogui.moveTo(data["x1"], data["y1"], duration=0.1)
    pyautogui.drag(
        data["x2"] - data["x1"],
        data["y2"] - data["y1"],
        duration=data.get("duration", 0.5),
    )
    return jsonify({"ok": True})


@app.post("/type")
def type_text():
    data = request.get_json()
    pyautogui.typewrite(data["text"], interval=0.02)
    return jsonify({"ok": True})


@app.post("/key")
def key():
    data = request.get_json()
    modifiers = data.get("modifiers", [])
    key_name = data["key"]
    if modifiers:
        pyautogui.hotkey(*modifiers, key_name)
    else:
        pyautogui.press(key_name)
    return jsonify({"ok": True})


@app.get("/screen")
def screen():
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        img = sct.grab(monitor)
        png = mss.tools.to_png(img.rgb, img.size)
    return send_file(io.BytesIO(png), mimetype="image/png")


@app.get("/size")
def screen_size():
    w, h = pyautogui.size()
    return jsonify({"w": w, "h": h})


if __name__ == "__main__":
    print("PD-Control Agent starting on http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000)
```

- [ ] **Step 2: Verify no syntax errors**

```bash
python -c "import ast; ast.parse(open('agent/agent.py').read()); print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add agent/agent.py
git commit -m "feat: add Windows Agent Flask server with 8 endpoints"
```

---

### Task 3: HTTP client library

**Files:**
- Create: `pd_control/client.py`

- [ ] **Step 1: Write pd_control/client.py**

```python
"""HTTP client for PD-Control Agent API."""
import os
from urllib.parse import urljoin

import requests


class AgentClient:
    """Thin HTTP wrapper around the Windows Agent API.

    Usage:
        c = AgentClient(host="10.211.55.3", port=5000)
        c.ping()
        c.click(500, 300)
        c.screen("shot.png")
    """

    def __init__(self, host=None, port=None):
        self.host = host or os.environ.get("PD_HOST", "10.211.55.3")
        self.port = port or int(os.environ.get("PD_PORT", "5000"))
        self.base = f"http://{self.host}:{self.port}"
        self._session = requests.Session()
        self._session.timeout = 10

    def _post(self, path, **data):
        r = self._session.post(urljoin(self.base, path), json=data)
        r.raise_for_status()
        return r.json()

    def _get(self, path):
        r = self._session.get(urljoin(self.base, path))
        r.raise_for_status()
        return r

    def ping(self):
        """Health check. Returns {"status": "ok"}."""
        return self._get("/ping").json()

    def click(self, x, y, button="left", clicks=1):
        """Click at screen coordinates."""
        return self._post("/click", x=x, y=y, button=button, clicks=clicks)

    def move(self, x, y, duration=0.2):
        """Move mouse to screen coordinates."""
        return self._post("/move", x=x, y=y, duration=duration)

    def drag(self, x1, y1, x2, y2, duration=0.5):
        """Drag from (x1,y1) to (x2,y2)."""
        return self._post("/drag", x1=x1, y1=y1, x2=x2, y2=y2, duration=duration)

    def type_text(self, text):
        """Type a string via keyboard."""
        return self._post("/type", text=text)

    def key(self, key_name, modifiers=None):
        """Press a key, optionally with modifiers (e.g. ['ctrl', 'shift'])."""
        return self._post("/key", key=key_name, modifiers=modifiers or [])

    def screen(self, path="screenshot.png"):
        """Capture screen and save to path. Returns the path."""
        r = self._get("/screen")
        with open(path, "wb") as f:
            f.write(r.content)
        return path

    def size(self):
        """Get screen resolution. Returns {"w": 1920, "h": 1080}."""
        return self._get("/size").json()
```

- [ ] **Step 2: Run a quick import check**

```bash
python -c "from pd_control.client import AgentClient; c = AgentClient(); print(f'Default host: {c.host}:{c.port}')"
```

Expected: `Default host: 10.211.55.3:5000`

- [ ] **Step 3: Commit**

```bash
git add pd_control/client.py
git commit -m "feat: add AgentClient HTTP wrapper library"
```

---

### Task 4: CLI entry point

**Files:**
- Create: `pd_control/cli.py`
- Modify: `pd_control/__init__.py` (if needed)

- [ ] **Step 1: Write pd_control/cli.py**

```python
"""PD-Control CLI — Control Windows VM mouse, keyboard, and screen from terminal."""
import sys
import typer

from pd_control.client import AgentClient

_HOST_HELP = "Agent host IP (env: PD_HOST)"
_PORT_HELP = "Agent port (env: PD_PORT)"

HostOpt = typer.Option("10.211.55.3", "--host", envvar="PD_HOST", help=_HOST_HELP)
PortOpt = typer.Option(5000, "--port", envvar="PD_PORT", help=_PORT_HELP)

app = typer.Typer(
    name="pd-control",
    help="Control Parallels Desktop Windows VM via mouse, keyboard, and screen capture.",
)


def _client(host: str, port: int) -> AgentClient:
    return AgentClient(host=host, port=port)


@app.command()
def ping(
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Test connection to the Windows Agent."""
    try:
        result = _client(host, port).ping()
        typer.echo(f"Agent status: {result['status']}")
    except Exception as e:
        typer.echo(f"Connection failed: {e}", err=True)
        raise typer.Exit(code=1)


@app.command()
def click(
    x: int = typer.Argument(..., help="X coordinate"),
    y: int = typer.Argument(..., help="Y coordinate"),
    button: str = typer.Option("left", "--button", "-b", help="Mouse button: left, right, middle"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Click at (x, y)."""
    _client(host, port).click(x, y, button=button)
    typer.echo(f"Clicked {button} at ({x}, {y})")


@app.command()
def move(
    x: int = typer.Argument(..., help="X coordinate"),
    y: int = typer.Argument(..., help="Y coordinate"),
    duration: float = typer.Option(0.2, "--duration", "-d", help="Move duration (seconds)"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Move mouse to (x, y)."""
    _client(host, port).move(x, y, duration=duration)
    typer.echo(f"Moved to ({x}, {y})")


@app.command()
def drag(
    x1: int = typer.Argument(..., help="Start X"),
    y1: int = typer.Argument(..., help="Start Y"),
    x2: int = typer.Argument(..., help="End X"),
    y2: int = typer.Argument(..., help="End Y"),
    duration: float = typer.Option(0.5, "--duration", "-d", help="Drag duration (seconds)"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Drag from (x1, y1) to (x2, y2)."""
    _client(host, port).drag(x1, y1, x2, y2, duration=duration)
    typer.echo(f"Dragged from ({x1}, {y1}) to ({x2}, {y2})")


@app.command(name="type")
def type_text(
    text: str = typer.Argument(..., help="Text to type"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Type text via keyboard."""
    _client(host, port).type_text(text)
    typer.echo(f"Typed: {text}")


@app.command()
def key(
    key_name: str = typer.Argument(..., help="Key name (enter, tab, esc, a, b, ...)"),
    ctrl: bool = typer.Option(False, "--ctrl", help="Hold Ctrl"),
    alt: bool = typer.Option(False, "--alt", help="Hold Alt"),
    shift: bool = typer.Option(False, "--shift", help="Hold Shift"),
    win: bool = typer.Option(False, "--win", help="Hold Win"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Press a key, optionally with modifiers."""
    modifiers = []
    if ctrl:
        modifiers.append("ctrl")
    if alt:
        modifiers.append("alt")
    if shift:
        modifiers.append("shift")
    if win:
        modifiers.append("win")
    _client(host, port).key(key_name, modifiers=modifiers)
    label = "+".join(modifiers + [key_name]) if modifiers else key_name
    typer.echo(f"Pressed: {label}")


@app.command()
def shot(
    output: str = typer.Option("screenshot.png", "--output", "-o", help="Output file path"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Capture a screenshot from the VM."""
    path = _client(host, port).screen(output)
    typer.echo(f"Screenshot saved to: {path}")


@app.command()
def size(
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Get the VM screen resolution."""
    result = _client(host, port).size()
    typer.echo(f"Screen: {result['w']}x{result['h']}")


def main():
    app()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify CLI loads correctly**

```bash
pip install -e . && pd-control --help
```

Expected: shows all 9 commands (ping, click, move, drag, type, key, shot, size) with descriptions.

- [ ] **Step 3: Test each command shows its own help**

```bash
pd-control click --help && pd-control move --help && pd-control drag --help && pd-control type --help && pd-control key --help && pd-control shot --help && pd-control size --help && pd-control ping --help
```

Expected: each command shows its arguments and options.

- [ ] **Step 4: Commit**

```bash
git add pd_control/cli.py
git commit -m "feat: add typer CLI with 9 commands"
```

---

### Task 5: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start and command reference"
```

---

### Task 6: Manual end-to-end verification

**Prerequisites:** Agent running in Windows VM, shared network configured.

- [ ] **Step 1: Copy agent/ to Windows VM**

Copy `agent/agent.py` and `agent/requirements.txt` to the Windows VM.

- [ ] **Step 2: Install Agent dependencies in VM**

```powershell
pip install flask pyautogui mss
```

- [ ] **Step 3: Start Agent in VM**

```powershell
python agent.py
```

Expected: `PD-Control Agent starting on http://0.0.0.0:5000`

- [ ] **Step 4: Verify connectivity from macOS**

```bash
pd-control --host <VM_IP> ping
```

Expected: `Agent status: ok`

If VM IP unknown, find it:

```bash
# Inside the VM, run:
ipconfig
# Look for IPv4 under the Ethernet adapter (e.g., 10.211.55.x)
```

- [ ] **Step 5: Test key operations manually**

```bash
# Move mouse (should see cursor move in VM)
pd-control --host <VM_IP> move 500 300

# Click (should see left click)
pd-control --host <VM_IP> click 500 300

# Type (open Notepad in VM first, then:)
pd-control --host <VM_IP> type "Hello from pd-control!"

# Screenshot
pd-control --host <VM_IP> shot -o test.png && open test.png

# Screen size
pd-control --host <VM_IP> size
```

- [ ] **Step 6: Package Agent to exe (optional, one-time)**

In Windows VM:

```powershell
pip install pyinstaller
pyinstaller --onefile agent.py --name pd-agent
```

Start the exe:

```powershell
.\dist\pd-agent.exe
```

Verify connectivity again from macOS:

```bash
pd-control --host <VM_IP> ping
```

Expected: `Agent status: ok`

---
