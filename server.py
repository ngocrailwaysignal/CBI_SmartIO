"""Smart IO Web Simulator as a SmartIO pass-through bridge.

Run:
    python server.py

Default endpoints:
    WebSocket: ws://127.0.0.1:8088/smartio
    Web UI:    http://127.0.0.1:8088/
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

    async def handle_socket(self, request: web.Request) -> web.WebSocketResponse:
        socket = web.WebSocketResponse(autoping=True, heartbeat=30)
        await socket.prepare(request)
        self._clients.add(socket)
        await self._send_snapshot(socket)

        async for message in socket:
            if message.type != WSMsgType.TEXT:
                continue
            await self._on_text_message(socket, str(message.data))

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

        self._normalize_selected_route()
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
        return dict(self.latest_runtime_snapshot)

    def _normalize_selected_route(self) -> None:
        route_states = self.latest_runtime_snapshot.get("routes", [])
        active_route_ids: list[str] = []
        for route_state in route_states:
            if not isinstance(route_state, dict):
                continue
            route_id = str(route_state.get("id", route_state.get("route_id", ""))).strip()
            if route_id:
                active_route_ids.append(route_id)
        active_route_ids = sorted(set(active_route_ids))
        if self.selected_route_id in active_route_ids:
            return
        self.selected_route_id = active_route_ids[0] if active_route_ids else None

    def _active_route_path_map(self) -> dict[str, list[str]]:
        route_paths: dict[str, list[str]] = {}
        for route_state in self.latest_runtime_snapshot.get("routes", []):
            if not isinstance(route_state, dict):
                continue
            route_id = str(route_state.get("id", route_state.get("route_id", ""))).strip()
            if not route_id:
                continue
            route_paths[route_id] = [
                *_normalize_node_list(route_state.get("path")),
                *_normalize_node_list(route_state.get("overlap_path")),
            ]
        return route_paths

    @staticmethod
    def _validate_runtime_snapshot(payload: dict[str, Any]) -> bool:
        required_list_fields = ("routes", "trains", "occupancy", "signal_state")
        return all(isinstance(payload.get(field), list) for field in required_list_fields)

    async def _send_error(self, socket: web.WebSocketResponse, code: str, message: str) -> None:
        envelope = {
            "type": "error",
            "payload": {"code": code, "message": message},
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
                    if isinstance(item, dict) and str(item.get("id", item.get("route_id", ""))).strip() == route_id
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
    parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind")
    parser.add_argument(
        "--port",
        type=int,
        default=8088,
        help="HTTP/WebSocket port",
    )
    parser.add_argument("--ws-path", default="/smartio", help="WebSocket route path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    layout_path = Path(args.layout).resolve()
    web_root = Path(__file__).resolve().parent / "web"
    if not layout_path.exists():
        raise FileNotFoundError(f"Layout file not found: {layout_path}")
    if not web_root.exists():
        raise FileNotFoundError(f"Web root not found: {web_root}")

    simulator = SmartIOWebSimulator(layout_path=layout_path)

    app = web.Application()
    app.router.add_get(str(args.ws_path), simulator.handle_socket)
    app.router.add_static("/", str(web_root), show_index=True)

    env_port = int(os.getenv("PORT", "0") or "0")
    port = env_port or int(args.port)

    print(f"[SmartIO] Web UI: http://{args.host}:{port}/")
    print(f"[SmartIO] WebSocket listening on ws://{args.host}:{port}{args.ws_path}")
    web.run_app(app, host=args.host, port=port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
