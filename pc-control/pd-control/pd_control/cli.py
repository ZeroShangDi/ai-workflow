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
    try:
        _client(host, port).click(x, y, button=button)
        typer.echo(f"Clicked {button} at ({x}, {y})")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


@app.command()
def move(
    x: int = typer.Argument(..., help="X coordinate"),
    y: int = typer.Argument(..., help="Y coordinate"),
    duration: float = typer.Option(0.2, "--duration", "-d", help="Move duration (seconds)"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Move mouse to (x, y)."""
    try:
        _client(host, port).move(x, y, duration=duration)
        typer.echo(f"Moved to ({x}, {y})")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


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
    try:
        _client(host, port).drag(x1, y1, x2, y2, duration=duration)
        typer.echo(f"Dragged from ({x1}, {y1}) to ({x2}, {y2})")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


@app.command(name="type")
def type_text(
    text: str = typer.Argument(..., help="Text to type"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Type text via keyboard."""
    try:
        _client(host, port).type_text(text)
        typer.echo(f"Typed: {text}")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


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
    try:
        _client(host, port).key(key_name, modifiers=modifiers)
        label = "+".join(modifiers + [key_name]) if modifiers else key_name
        typer.echo(f"Pressed: {label}")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


@app.command()
def shot(
    output: str = typer.Option("screenshot.png", "--output", "-o", help="Output file path"),
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Capture a screenshot from the VM."""
    try:
        path = _client(host, port).screen(output)
        typer.echo(f"Screenshot saved to: {path}")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


@app.command()
def size(
    host: str = HostOpt,
    port: int = PortOpt,
):
    """Get the VM screen resolution."""
    try:
        result = _client(host, port).size()
        typer.echo(f"Screen: {result['w']}x{result['h']}")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(code=1)


def main():
    app()


if __name__ == "__main__":
    main()
