from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class ScreenSize:
    w: int
    h: int


class InputBackend(ABC):
    """Pluggable abstraction for mouse, keyboard, and screen control.

    Each concrete backend implements all operations. Backends that
    cannot provide screen capture raise NotImplementedError for
    screenshot() and screen_size().
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique backend identifier, e.g. 'pyautogui', 'interception'."""
        ...

    # -- Mouse -------------------------------------------------------

    @abstractmethod
    def click(self, x: int, y: int, button: str = "left",
              clicks: int = 1) -> None:
        """Move to (x,y) and click."""
        ...

    @abstractmethod
    def move(self, x: int, y: int, duration: float = 0.2) -> None:
        """Move the mouse cursor to (x,y) over *duration* seconds."""
        ...

    @abstractmethod
    def drag(self, x1: int, y1: int, x2: int, y2: int,
             duration: float = 0.5) -> None:
        """Drag from (x1,y1) to (x2,y2)."""
        ...

    def position(self) -> Tuple[int, int]:
        """Current mouse cursor position. Returns (0,0) by default."""
        return 0, 0

    # -- Keyboard ----------------------------------------------------

    @abstractmethod
    def type_text(self, text: str, interval: float = 0.02) -> None:
        """Type *text* character by character."""
        ...

    @abstractmethod
    def key_press(self, key: str) -> None:
        """Press and release a single key."""
        ...

    @abstractmethod
    def key_combo(self, modifiers: List[str], key: str) -> None:
        """Press modifiers + key simultaneously, then release."""
        ...

    # -- Screen ------------------------------------------------------

    @abstractmethod
    def screenshot(self) -> bytes:
        """Capture primary monitor, return PNG bytes.

        Raises NotImplementedError if the backend cannot capture screen.
        """
        ...

    @abstractmethod
    def screen_size(self) -> ScreenSize:
        """Return primary monitor resolution.

        Raises NotImplementedError if the backend cannot query screen.
        """
        ...
