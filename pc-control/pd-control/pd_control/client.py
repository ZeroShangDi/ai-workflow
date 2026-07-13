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
        self._timeout = 10

    def _post(self, path, **data):
        r = self._session.post(urljoin(self.base, path), json=data, timeout=self._timeout)
        r.raise_for_status()
        return r.json()

    def _get(self, path):
        r = self._session.get(urljoin(self.base, path), timeout=self._timeout)
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
