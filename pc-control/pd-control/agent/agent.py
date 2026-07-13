"""PD-Control Agent — Runs inside Windows VM.
Exposes HTTP API for mouse, keyboard, and screen control.

Start with: python agent.py
Package to exe: pyinstaller --onefile agent.py --name pd-agent

Configuration:
  GET  /config              → {"backend": "pyautogui", "behavior": null}
  POST /config              → switch backend / behavior at runtime
         {"behavior": "casual"}
         {"backend": "pyautogui", "behavior": null}
"""
import io
from typing import Optional

from flask import Flask, request, jsonify, send_file

from backends.base import InputBackend
from backends.pyautogui_backend import PyAutoGuiBackend
from behavior.human import HumanBehavior

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Backend registry & state
# ---------------------------------------------------------------------------

_backend_registry = {
    "pyautogui": lambda: PyAutoGuiBackend(),
    # "interception": lambda: InterceptionBackend(),
}

_backend_name: str = "pyautogui"
_behavior_mode: Optional[str] = None
_input: InputBackend = PyAutoGuiBackend()


def _build_input():
    factory = _backend_registry.get(_backend_name)
    if factory is None:
        raise ValueError(f"Unknown backend: {_backend_name}")
    be = factory()
    if _behavior_mode and _behavior_mode != "bot":
        be = HumanBehavior(be, mode=_behavior_mode)
    return be


def _require_fields(data, required):
    missing = [f for f in required if f not in data]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    return None


# ---------------------------------------------------------------------------
# Config endpoint
# ---------------------------------------------------------------------------

@app.route("/config", methods=["GET", "POST"])
def config():
    global _backend_name, _behavior_mode, _input

    if request.method == "GET":
        return jsonify({
            "backend": _backend_name,
            "behavior": _behavior_mode,
        })

    data = request.get_json() or {}
    new_backend = data.get("backend")
    new_behavior = data.get("behavior")

    if new_backend is not None:
        if new_backend not in _backend_registry:
            return jsonify({"error": f"Unknown backend: {new_backend}"}), 400
        _backend_name = new_backend

    if "behavior" in data:
        _behavior_mode = new_behavior

    try:
        _input = _build_input()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "backend": _backend_name,
        "behavior": _behavior_mode,
    })


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/ping")
def ping():
    try:
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/click")
def click():
    try:
        data = request.get_json()
        err = _require_fields(data, ["x", "y"])
        if err:
            return err
        _input.click(
            x=data["x"],
            y=data["y"],
            button=data.get("button", "left"),
            clicks=data.get("clicks", 1),
        )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/move")
def move():
    try:
        data = request.get_json()
        err = _require_fields(data, ["x", "y"])
        if err:
            return err
        _input.move(
            x=data["x"],
            y=data["y"],
            duration=data.get("duration", 0.2),
        )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/drag")
def drag():
    try:
        data = request.get_json()
        err = _require_fields(data, ["x1", "y1", "x2", "y2"])
        if err:
            return err
        _input.drag(
            x1=data["x1"], y1=data["y1"],
            x2=data["x2"], y2=data["y2"],
            duration=data.get("duration", 0.5),
        )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/type")
def type_text():
    try:
        data = request.get_json()
        err = _require_fields(data, ["text"])
        if err:
            return err
        _input.type_text(data["text"], interval=data.get("interval", 0.02))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/key")
def key():
    try:
        data = request.get_json()
        err = _require_fields(data, ["key"])
        if err:
            return err
        modifiers = data.get("modifiers", [])
        if modifiers:
            _input.key_combo(modifiers, data["key"])
        else:
            _input.key_press(data["key"])
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/screen")
def screen():
    try:
        png = _input.screenshot()
        return send_file(io.BytesIO(png), mimetype="image/png")
    except NotImplementedError:
        return jsonify({
            "error": f"Backend '{_input.name}' does not support screenshots"
        }), 501
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/size")
def screen_size():
    try:
        sz = _input.screen_size()
        return jsonify({"w": sz.w, "h": sz.h})
    except NotImplementedError:
        return jsonify({
            "error": f"Backend '{_input.name}' does not support screen size"
        }), 501
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("PD-Control Agent starting on http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000)
