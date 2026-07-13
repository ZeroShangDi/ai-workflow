"""Stub backend for the Interception kernel-level HID driver.

Interception installs a signed Windows filter driver above the HID class
driver stack. Injections at this layer appear to applications as genuine
hardware events — no LLMHF_INJECTED flag, no detectable hooks.

Reference: https://github.com/oblitum/Interception
"""
from typing import List, Tuple

from backends.base import InputBackend, ScreenSize


class InterceptionBackend(InputBackend):
    """Kernel-level HID injection backend (not yet implemented).

    Does NOT support screen capture — pair with a separate capture source.
    """

    @property
    def name(self) -> str:
        return "interception"

    def click(self, x, y, button="left", clicks=1):
        raise NotImplementedError("interception: click")

    def move(self, x, y, duration=0.2):
        raise NotImplementedError("interception: move")

    def drag(self, x1, y1, x2, y2, duration=0.5):
        raise NotImplementedError("interception: drag")

    def type_text(self, text, interval=0.02):
        raise NotImplementedError("interception: type_text")

    def key_press(self, key):
        raise NotImplementedError("interception: key_press")

    def key_combo(self, modifiers, key):
        raise NotImplementedError("interception: key_combo")

    def screenshot(self):
        raise NotImplementedError("interception: screenshot not supported")

    def screen_size(self):
        raise NotImplementedError("interception: screen_size not supported")
