"""Read-only development API. Authentication is deliberately not bypassed for commands."""
from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from service import ArmorService


def handler_for(service: ArmorService):
    class ArmorHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - required stdlib handler name
            if self.path == "/healthz":
                self._json(HTTPStatus.OK, {"ok": True})
            elif self.path == "/api/v1/status":
                self._json(HTTPStatus.OK, service.status())
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "read-only development API"})

        def log_message(self, *_: object) -> None:
            return

        def _json(self, status: HTTPStatus, body: dict[str, object]) -> None:
            encoded = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)
    return ArmorHandler


def serve(service: ArmorService, host: str = "127.0.0.1", port: int = 8080) -> ThreadingHTTPServer:
    """Create but do not start a loop, making test and supervised launch simple."""
    return ThreadingHTTPServer((host, port), handler_for(service))
