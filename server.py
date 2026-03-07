"""Smart IO Web Simulator as a SmartIO pass-through bridge.

Run:
    python server.py

Default endpoint:
    HTTP + WebSocket: http://0.0.0.0:8088/ (WebSocket path: /smartio)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _now_ts() -> float:
    return time.time()


def _route_pair_key(entry_signal: str, exit_signal: str) -> str:
    entry = str(entry_signal).strip()
    exit_ = str(exit_signal).strip()
    if not entry or not exit_:
        return ""
    return f"{entry}->{exit_}"


def _normalize_node_list(raw_value: Any) -> list[str]:
    if not isinstance(raw_value, list):
        return []
    return [str(item).strip() for item in raw_value if str(item).strip()]


class SmartIOWebSimulator:
    """Bridge between CBI and web clients without interlocking execution."""

    def __init__(self, *, layout_path: Path) -> None:
        self.layout_path = layout_path
        self.layout_payload = _read_json(layout_path)
        self.latest_runtime_snapshot: dict[str, Any] = {
            "tick": 0,
            "routes": [],
            "trains": [],
            "occupancy": [],
            "signal_state": [],
        }
        self.selected_route_id: str | None = None

        self._clients: set[web.WebSocketResponse] = set()
        self._web_clients: set[web.WebSocketResponse] = set()
        self._cbi_clients: set[web.WebSocketResponse] = set()

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        socket = web.WebSocketResponse(heartbeat=30)
        await socket.prepare(request)

        self._clients.add(socket)
        await self._send_snapshot(socket)

        try:
            async for msg in socket:
                if msg.type != WSMsgType.TEXT:
                    continue
                await self._on_text_message(socket, msg.data)
        finally:
            self._on_disconnected(socket)

        return socket

    def _on_disconnected(self, socket: web.WebSocketResponse) -> None:
        self._clients.discard(socket)
        self._web_clients.discard(socket)
        self._cbi_clients.discard(socket)

    async def _on_text_message(self, socket: web.WebSocketResponse, raw_message: str) -> None:
        try:
            envelope = json.loads(raw_message)
        except json.JSONDecodeError:
            await self._send_error(socket, "INVALID_JSON", "Message must be valid JSON")
            return
        if not isinstance(envelope, dict):
            await self._send_error(socket, "INVALID_ENVELOPE", "Message must be object")
            return
        message_type = str(envelope.get("type", "")).strip()
        payload = envelope.get("payload", {})
        if not isinstance(payload, dict):
            await self._send_error(socket, "INVALID_PAYLOAD", "payload must be object")
            return

        if message_type == "hello":
            await self._handle_hello(socket, payload)
            return

        if message_type == "command":
            self._cbi_clients.add(socket)
            await self._broadcast_web(
                {
                    "type": "cbi_command",
                    "payload": payload,
                    "ts": envelope.get("ts", _now_ts()),
                }
            )
            await self._broadcast_snapshot()
            return

        if message_type == "runtime_snapshot":
            self._cbi_clients.add(socket)
            if not self._validate_runtime_snapshot(payload):
                await self._send_error(socket, "INVALID_PAYLOAD", "runtime_snapshot payload is invalid")
                return
            runtime_layout = payload.get("layout")
            if isinstance(runtime_layout, dict):
                self.layout_payload = dict(runtime_layout)
            self.latest_runtime_snapshot = dict(payload)
            self._normalize_selected_route()
            await self._broadcast_web(
                {
                    "type": "runtime_snapshot",
                    "payload": payload,
                    "ts": envelope.get("ts", _now_ts()),
                }
            )
            await self._broadcast_snapshot()
            return

        if message_type == "state_update":
            self._web_clients.add(socket)
            msg_id = str(envelope.get("msg_id", "")).strip()
            if msg_id:
                await self._send_ack(socket, "state_update", msg_id, "received")
            await self._forward_to_cbi(
                {
                    "type": "state_update",
                    "payload": payload,
                    "ts": envelope.get("ts", _now_ts()),
                }
            )
            return

        if message_type == "web_control":
            self._web_clients.add(socket)
            await self._apply_web_control(socket, payload)
            return

        await self._send_error(socket, "UNSUPPORTED_TYPE", f"Unsupported type {message_type}")

    async def _handle_hello(self, socket: web.WebSocketResponse, payload: dict[str, Any]) -> None:
        role = str(payload.get("role", "")).strip().lower()
        if role == "web":
            self._web_clients.add(socket)
        elif role == "cbi":
            self._cbi_clients.add(socket)
        await self._send_snapshot(socket)

    async def _apply_web_control(self, socket: web.WebSocketResponse, payload: dict[str, Any]) -> None:
        action = str(payload.get("action", "")).strip()
        if action in {"set_active_route", "set_selected_route"}:
            route_id = str(payload.get("route_id", "")).strip()
            self.selected_route_id = route_id or None
            await self._broadcast_snapshot()
            return
        await self._send_error(socket, "UNKNOWN_WEB_CONTROL", f"Unsupported action {action}")

    def _runtime_payload(self) -> dict[str, Any]:
        snapshot = self.latest_runtime_snapshot if isinstance(self.latest_runtime_snapshot, dict) else {}

        sections: list[dict[str, Any]] = []
        points: list[dict[str, Any]] = []
        for node_state in snapshot.get("occupancy", []):
            if not isinstance(node_state, dict):
                continue
            node_id = str(node_state.get("id", "")).strip()
            if not node_id:
                continue
            if "occupied" in node_state:
                sections.append(
                    {
                        "id": node_id,
                        "occupied": bool(node_state.get("occupied", False)),
                        "locked_by": node_state.get("locked_by"),
                    }
                )
            if "position" in node_state:
                points.append(
                    {
                        "id": node_id,
                        "position": str(node_state.get("position", "")).strip().upper(),
                        "locked_by": node_state.get("locked_by"),
                    }
                )

        signals: list[dict[str, Any]] = []
        for signal_state in snapshot.get("signal_state", []):
            if not isinstance(signal_state, dict):
                continue
            signal_id = str(signal_state.get("id", "")).strip()
            if not signal_id:
                continue
            signals.append(
                {
                    "id": signal_id,
                    "aspect": str(signal_state.get("aspect", "STOP")).strip().upper(),
                    "route_id": signal_state.get("route_id"),
                }
            )

        active_routes: list[dict[str, Any]] = []
        for route_state in snapshot.get("routes", []):
            if not isinstance(route_state, dict):
                continue
            route_id = str(route_state.get("id", route_state.get("route_id", ""))).strip()
            if not route_id:
                continue
            active_routes.append(
                {
                    "route_id": route_id,
                    "entry_signal_id": str(route_state.get("entry_signal_id", "")).strip(),
                    "exit_signal_id": str(route_state.get("exit_signal_id", "")).strip(),
                    "path": _normalize_node_list(route_state.get("path")),
                    "overlap_path": _normalize_node_list(route_state.get("overlap_path")),
                    "lifecycle_state": str(route_state.get("lifecycle_state", "")).strip(),
                }
            )

        trains: list[dict[str, Any]] = []
        for train_state in snapshot.get("trains", []):
            if not isinstance(train_state, dict):
                continue
            train_id = str(train_state.get("id", "")).strip()
            if not train_id:
                continue
            trains.append(
                {
                    "id": train_id,
                    "current_section": str(train_state.get("current_section", "")).strip(),
                    "speed": float(train_state.get("speed", 0.0) or 0.0),
                    "route_id": train_state.get("route_id"),
                }
            )

        return {
            "tick": int(snapshot.get("tick", 0) or 0),
            "sections": sections,
            "points": points,
            "signals": signals,
            "active_routes": active_routes,
            "trains": trains,
            "selected_route_id": self.selected_route_id,
        }

    def _runtime_snapshot_payload(self) -> dict[str, Any]:
        snapshot = self.latest_runtime_snapshot if isinstance(self.latest_runtime_snapshot, dict) else {}
        return {
            "tick": int(snapshot.get("tick", 0) or 0),
            "routes": snapshot.get("routes", []) if isinstance(snapshot.get("routes"), list) else [],
            "trains": snapshot.get("trains", []) if isinstance(snapshot.get("trains"), list) else [],
            "occupancy": snapshot.get("occupancy", []) if isinstance(snapshot.get("occupancy"), list) else [],
            "signal_state": snapshot.get("signal_state", []) if isinstance(snapshot.get("signal_state"), list) else [],
        }

    def _validate_runtime_snapshot(self, payload: dict[str, Any]) -> bool:
        expected = ("tick", "routes", "trains", "occupancy", "signal_state")
        for key in expected:
            if key not in payload:
                return False
        return all(isinstance(payload.get(k), list) for k in ("routes", "trains", "occupancy", "signal_state"))

    def _normalize_selected_route(self) -> None:
        selected = str(self.selected_route_id or "").strip()
        if not selected:
            self.selected_route_id = None
            return
        if selected in self._active_route_path_map():
            self.selected_route_id = selected
            return
        self.selected_route_id = None

    def _active_route_path_map(self) -> dict[str, list[str]]:
        snapshot = self.latest_runtime_snapshot if isinstance(self.latest_runtime_snapshot, dict) else {}
        path_map: dict[str, list[str]] = {}
        for route_state in snapshot.get("routes", []):
            if not isinstance(route_state, dict):
                continue
            route_id = str(route_state.get("id", route_state.get("route_id", ""))).strip()
            if not route_id:
                continue
            if str(route_state.get("status", "")).strip().upper() != "ACTIVE":
                continue
            full_path = _normalize_node_list(route_state.get("full_path", []))
            if full_path:
                path_map[route_id] = full_path
        return path_map

    async def _send_error(self, socket: web.WebSocketResponse, code: str, message: str) -> None:
        envelope = {
            "type": "error",
            "payload": {"code": code, "message": message},
            "ts": _now_ts(),
        }
        await self._send(socket, envelope)

    async def _send_ack(
        self,
        socket: web.WebSocketResponse,
        for_type: str,
        msg_id: str,
        status: str = "received",
    ) -> None:
        envelope = {
            "type": "ack",
            "payload": {
                "for_type": str(for_type).strip(),
                "msg_id": str(msg_id).strip(),
                "status": str(status).strip(),
            },
            "ts": _now_ts(),
        }
        await self._send(socket, envelope)

    async def _send(self, socket: web.WebSocketResponse, envelope: dict[str, Any]) -> None:
        if socket.closed:
            return
        try:
            await socket.send_str(json.dumps(envelope, ensure_ascii=False))
        except Exception:
            return

    async def _broadcast_web(self, envelope: dict[str, Any]) -> None:
        targets = self._web_clients if self._web_clients else self._clients
        await asyncio.gather(*(self._send(socket, envelope) for socket in list(targets)), return_exceptions=True)

    async def _forward_to_cbi(self, envelope: dict[str, Any]) -> None:
        await asyncio.gather(*(self._send(socket, envelope) for socket in list(self._cbi_clients)), return_exceptions=True)

    async def _broadcast_snapshot(self) -> None:
        envelope = self._snapshot_envelope()
        await asyncio.gather(*(self._send(socket, envelope) for socket in list(self._clients)), return_exceptions=True)

    async def _send_snapshot(self, socket: web.WebSocketResponse) -> None:
        await self._send(socket, self._snapshot_envelope())

    def _snapshot_envelope(self) -> dict[str, Any]:
        runtime_payload = self._runtime_payload()
        runtime_snapshot = self._runtime_snapshot_payload()

        by_active_route_id = self._active_route_path_map()
        by_pair: dict[str, list[str]] = {}
        for route_id, full_path in by_active_route_id.items():
            route_state = next(
                (
                    item
                    for item in runtime_snapshot.get("routes", [])
                    if isinstance(item, dict)
                    and str(item.get("id", item.get("route_id", ""))).strip() == route_id
                ),
                None,
            )
            if not isinstance(route_state, dict):
                continue
            pair_key = _route_pair_key(
                str(route_state.get("entry_signal_id", "")).strip(),
                str(route_state.get("exit_signal_id", "")).strip(),
            )
            if pair_key:
                by_pair[pair_key] = list(full_path)

        payload = {
            "layout": self.layout_payload,
            "runtime": runtime_payload,
            "runtime_snapshot": runtime_snapshot,
            "route_path_map": {
                "by_active_route_id": by_active_route_id,
                "by_compiled_id": {},
                "by_pair": by_pair,
            },
            "connected": {
                "web_clients": len(self._web_clients),
                "cbi_clients": len(self._cbi_clients),
            },
        }
        return {"type": "sim_snapshot", "payload": payload, "ts": _now_ts()}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smart IO Web Simulator")
    parser.add_argument(
        "--layout",
        default="data/sample_layout.json",
        help="Path to layout JSON used by simulator",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("HOST", "0.0.0.0"),
        help="Host/IP for binding HTTP + WebSocket",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8088")),
        help="Port for HTTP + WebSocket",
    )
    return parser.parse_args()


def create_app(layout_path: Path, web_root: Path) -> web.Application:
    simulator = SmartIOWebSimulator(layout_path=layout_path)
    app = web.Application()

    async def ws_handler(request: web.Request) -> web.StreamResponse:
        return await simulator.handle_ws(request)

    async def index_handler(request: web.Request) -> web.StreamResponse:
        return web.FileResponse(web_root / "index.html")

    app.router.add_get("/", index_handler)
    app.router.add_get("/smartio", ws_handler)
    app.router.add_static("/", path=str(web_root), show_index=False)
    return app


def main() -> int:
    args = parse_args()
    layout_path = Path(args.layout).resolve()
    web_root = Path(__file__).resolve().parent / "web"
    if not layout_path.exists():
        raise FileNotFoundError(f"Layout file not found: {layout_path}")
    if not web_root.exists():
        raise FileNotFoundError(f"Web root not found: {web_root}")

    print(f"[SmartIO] HTTP + WebSocket listening on http://{args.host}:{args.port}/")
    print("[SmartIO] WebSocket path: /smartio")

    app = create_app(layout_path=layout_path, web_root=web_root)
    web.run_app(app, host=args.host, port=int(args.port), print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
