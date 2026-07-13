import math
import random
import time
from typing import List, Tuple

from backends.base import InputBackend, ScreenSize


def _bezier_point(t: float,
                  p0: Tuple[float, float],
                  p1: Tuple[float, float],
                  p2: Tuple[float, float],
                  p3: Tuple[float, float]) -> Tuple[int, int]:
    """Cubic bezier at parameter t in [0,1]."""
    u = 1 - t
    x = (u ** 3) * p0[0] + 3 * (u ** 2) * t * p1[0] \
        + 3 * u * (t ** 2) * p2[0] + (t ** 3) * p3[0]
    y = (u ** 3) * p0[1] + 3 * (u ** 2) * t * p1[1] \
        + 3 * u * (t ** 2) * p2[1] + (t ** 3) * p3[1]
    return int(x), int(y)


class HumanBehavior(InputBackend):
    """Decorator that wraps an InputBackend with human-like patterns.

    Modes:
      - "bot"      : passthrough, no modification
      - "precise"  : minimal jitter, subtle bezier
      - "casual"   : noticeable bezier, variable typing cadence
    """

    _MODES = {
        "bot":     (0,   0.02, 0.02, 0),
        "precise": (1,   0.01, 0.04, 0.15),
        "casual":  (3,   0.02, 0.08, 0.30),
    }

    def __init__(self, backend: InputBackend, mode: str = "casual"):
        self._be = backend
        self.mode = mode

    @property
    def name(self) -> str:
        return f"human({self._be.name}, mode={self.mode})"

    # -- mode helpers -------------------------------------------------

    @property
    def _cfg(self):
        return self._MODES.get(self.mode, self._MODES["bot"])

    def _jitter(self) -> int:
        j = self._cfg[0]
        return random.randint(-j, j) if j else 0

    def _type_delay(self, base: float) -> float:
        lo, hi = self._cfg[1], self._cfg[2]
        val = random.gauss(base, base * 0.5)
        return max(lo, min(hi, val))

    def _bezier_offset(self, distance: float) -> float:
        return self._cfg[3]

    # -- Mouse --------------------------------------------------------

    def click(self, x: int, y: int, button: str = "left",
              clicks: int = 1) -> None:
        x += self._jitter()
        y += self._jitter()
        if self.mode != "bot":
            self.move(x, y)
        self._be.click(x, y, button, clicks)

    def move(self, x: int, y: int, duration: float = 0.2) -> None:
        if self.mode == "bot":
            self._be.move(x, y, duration)
            return

        px, py = self._be.position()
        dist = math.hypot(x - px, y - py)

        if dist < 10 or self._bezier_offset(dist) == 0:
            self._be.move(x, y, duration)
            return

        offset = int(dist * self._bezier_offset(dist))
        cp1 = (px + random.randint(-offset, offset),
               py + random.randint(-offset, offset))
        cp2 = (x + random.randint(-offset, offset),
               y + random.randint(-offset, offset))

        steps = max(10, min(50, int(dist / 5)))
        step_dur = duration / steps
        for i in range(steps + 1):
            t = i / steps
            ix, iy = _bezier_point(t, (float(px), float(py)),
                                   (float(cp1[0]), float(cp1[1])),
                                   (float(cp2[0]), float(cp2[1])),
                                   (float(x), float(y)))
            self._be.move(ix, iy, duration=step_dur)

    def drag(self, x1: int, y1: int, x2: int, y2: int,
             duration: float = 0.5) -> None:
        if self.mode == "bot":
            self._be.drag(x1, y1, x2, y2, duration)
        else:
            self.move(x1, y1, duration=0.1)
            self._be.drag(x1, y1, x2, y2, duration)

    def position(self) -> Tuple[int, int]:
        return self._be.position()

    # -- Keyboard -----------------------------------------------------

    def type_text(self, text: str, interval: float = 0.02) -> None:
        if self.mode == "bot":
            self._be.type_text(text, interval)
            return
        for ch in text:
            self._be.key_press(ch)
            delay = interval * (3 if ch in " .;,\n" else 1)
            time.sleep(self._type_delay(delay))

    def key_press(self, key: str) -> None:
        self._be.key_press(key)

    def key_combo(self, modifiers: List[str], key: str) -> None:
        self._be.key_combo(modifiers, key)

    # -- Screen (passthrough) -----------------------------------------

    def screenshot(self) -> bytes:
        return self._be.screenshot()

    def screen_size(self) -> ScreenSize:
        return self._be.screen_size()
