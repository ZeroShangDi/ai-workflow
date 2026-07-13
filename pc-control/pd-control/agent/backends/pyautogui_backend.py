import io
from typing import List, Tuple

import pyautogui
import mss

from backends.base import InputBackend, ScreenSize


class PyAutoGuiBackend(InputBackend):
    """Input backend backed by pyautogui (user32.SendInput) + mss."""

    def __init__(self):
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.01

    @property
    def name(self) -> str:
        return "pyautogui"

    # -- Mouse -------------------------------------------------------

    def click(self, x: int, y: int, button: str = "left",
              clicks: int = 1) -> None:
        pyautogui.click(x=x, y=y, button=button, clicks=clicks)

    def move(self, x: int, y: int, duration: float = 0.2) -> None:
        pyautogui.moveTo(x=x, y=y, duration=duration)

    def drag(self, x1: int, y1: int, x2: int, y2: int,
             duration: float = 0.5) -> None:
        pyautogui.moveTo(x1, y1)
        pyautogui.dragTo(x2, y2, duration=duration)

    def position(self) -> Tuple[int, int]:
        p = pyautogui.position()
        return p.x, p.y

    # -- Keyboard ----------------------------------------------------

    def type_text(self, text: str, interval: float = 0.02) -> None:
        pyautogui.typewrite(text, interval=interval)

    def key_press(self, key: str) -> None:
        pyautogui.press(key)

    def key_combo(self, modifiers: List[str], key: str) -> None:
        pyautogui.hotkey(*modifiers, key)

    # -- Screen ------------------------------------------------------

    def screenshot(self) -> bytes:
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            img = sct.grab(monitor)
            png = mss.tools.to_png(img.rgb, img.size)
        return png

    def screen_size(self) -> ScreenSize:
        w, h = pyautogui.size()
        return ScreenSize(w=w, h=h)
