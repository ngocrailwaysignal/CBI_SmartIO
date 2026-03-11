"""Local-only SmartIO launcher for desktop testing.

Run:
    python tools/CBI_SmartIO/run_local_host.py --layout data/test.json
"""

from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run SmartIO on localhost for testing")
    parser.add_argument(
        "--layout",
        default="data/test.json",
        help="Path to layout JSON used by SmartIO",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Local bind host",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8088,
        help="Local bind port",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not auto-open the browser",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    layout_path = (repo_root / args.layout).resolve()
    if not layout_path.exists():
        raise FileNotFoundError(f"Layout file not found: {layout_path}")

    try:
        from aiohttp import web
        from server import create_app
    except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
        missing = getattr(exc, "name", "dependency")
        print(
            f"Missing dependency: {missing}. Install with "
            f"`python -m pip install -r tools/CBI_SmartIO/requirements.txt`.",
            file=sys.stderr,
        )
        return 1

    web_root = Path(__file__).resolve().parent / "web"
    app = create_app(layout_path=layout_path, web_root=web_root)
    base_url = f"http://{args.host}:{int(args.port)}/"

    print(f"[SmartIO Local] Serving {layout_path}")
    print(f"[SmartIO Local] Open {base_url}")
    print(f"[SmartIO Local] WebSocket ws://{args.host}:{int(args.port)}/smartio")

    if not args.no_browser:
        webbrowser.open(base_url)

    web.run_app(app, host=args.host, port=int(args.port), print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
