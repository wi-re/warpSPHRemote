"""Explicit desktop-protocol launch and private fragment pairing handoff."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, urlencode
import webbrowser
from .daemon import ensure_daemon

VIEWER = "https://fluids.dev/warpSPHRemote/"


def handoff(info):
    # Fragments are not sent to the web host or stored as HTTP query credentials.
    return (
        VIEWER + "#" + urlencode({"companion": info["endpoint"], "pair": info["token"]})
    )


def install_xdg(directory=None, register=True):
    target = Path(
        directory
        or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        / "applications"
    )
    target.mkdir(parents=True, exist_ok=True)
    executable = sys.executable.replace("\\", "\\\\").replace('"', '\\"')
    path = target / "warpsph-remote.desktop"
    path.write_text(
        "[Desktop Entry]\nType=Application\nName=warpSPH companion\nNoDisplay=true\n"
        f'Exec="{executable}" -m warpsph_remote.launcher %u\nMimeType=x-scheme-handler/warpsph;\nTerminal=false\n'
    )
    if register:
        subprocess.run(
            ["xdg-mime", "default", path.name, "x-scheme-handler/warpsph"], check=True
        )
    return path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("uri", nargs="?", default="warpsph://connect")
    p.add_argument("--install-xdg", action="store_true")
    p.add_argument("--runtime", type=Path)
    p.add_argument("--print-url", action="store_true")
    a = p.parse_args()
    if a.install_xdg:
        print(install_xdg())
        return
    parsed = urlsplit(a.uri)
    if (
        parsed.scheme != "warpsph"
        or parsed.netloc != "connect"
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        p.error("Only warpsph://connect is supported.")
    info = ensure_daemon(a.runtime)
    if a.print_url:
        print(handoff(info))
    else:
        webbrowser.open(handoff(info))


if __name__ == "__main__":
    main()
