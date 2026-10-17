"""Loopback-only file service. All scene rendering happens in the browser."""
from __future__ import annotations
import argparse
from collections import OrderedDict
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.parse import parse_qs, unquote, urlsplit
import uuid
import mimetypes

from .sources import DemoSource, open_source
from .protocol import encode_frame


class Application:
    def __init__(self, paths=(), web_root=None):
        self.web_root = Path(web_root) if web_root else Path(__file__).resolve().parents[2]/"dist"
        self.sources = OrderedDict()
        self.lock = threading.RLock()
        self.workers = threading.BoundedSemaphore(3)
        self.diagnostics = OrderedDict()
        for path in paths:
            self.add(open_source(path))
        self.add(DemoSource(2), "demo-2d")
        self.add(DemoSource(3), "demo-3d")

    def add(self, source, key=None):
        with self.lock:
            if len(self.sources) >= 64:
                raise ValueError("This local session has 64 sources. Restart the service to clear them.")
            key = key or uuid.uuid4().hex[:12]
            self.sources[key] = source
        return {"id": key, **source.metadata()}

    def diagnostic(self, source_id, index):
        key = (source_id, index)
        with self.lock:
            row = self.diagnostics.get(key)
        if row is None:
            row = self.sources[source_id].diagnostic(index)
            with self.lock:
                self.diagnostics[key] = row
                if len(self.diagnostics) > 8192:
                    self.diagnostics.popitem(last=False)
        return row


class Handler(BaseHTTPRequestHandler):
    server_version = "warpSPHRemote/0.1"
    def __init__(self, *args, application, **kwargs):
        self.app = application
        super().__init__(*args, **kwargs)

    def _local(self):
        host = self.headers.get("Host", "")
        host_name = urlsplit("http://"+host).hostname
        if host_name not in ("127.0.0.1", "localhost", "::1"):
            self._json({"error": "Only loopback hosts are accepted."}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
                self._json({"error": "Cross-origin requests are not permitted."}, 403)
                return False
            # Vite's local development proxy is the only additional origin.
            if parsed.netloc != host and parsed.port != 5173:
                self._json({"error": "Cross-origin requests are not permitted."}, 403)
                return False
        return True

    def _send(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(json.dumps(obj, allow_nan=False).encode(), "application/json", status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._local():
            return
        url = urlsplit(self.path)
        parts = url.path.strip("/").split("/")
        q = parse_qs(url.query)
        try:
            if url.path == "/api/sources":
                with self.app.lock:
                    rows = [{"id": k, **s.metadata()} for k, s in self.app.sources.items()]
                self._json(rows)
            elif len(parts) >= 4 and parts[:2] == ["api", "sources"]:
                key = parts[2]
                source = self.app.sources[key]
                if parts[3] == "frames" and len(parts) == 5:
                    index = int(parts[4])
                    field = q.get("field", ["velocities"])[0]
                    if field not in {f["name"] for f in source.fields}:
                        raise ValueError(f"Field {field!r} is not available in this source.")
                    with self.app.workers:
                        arrays = source.read(index, field)
                        if field not in arrays:
                            raise ValueError(f"Field {field!r} is missing from this frame.")
                        packet = encode_frame(arrays, index=index, time=source.times[index])
                    self._send(packet, "application/octet-stream")
                elif parts[3] == "diagnostics" and len(parts) == 4:
                    start = int(q.get("start", ["0"])[0])
                    count = int(q.get("count", ["16"])[0])
                    if not 0 <= start <= len(source.times) or not 1 <= count <= 32:
                        raise ValueError("Diagnostic batch must contain 1–32 frames within this source.")
                    with self.app.workers:
                        rows = [self.app.diagnostic(key, i) for i in range(start, min(start+count, len(source.times)))]
                    self._json(rows)
                else:
                    self._json({"error": "Unknown API endpoint."}, 404)
            elif url.path.startswith("/api/"):
                self._json({"error": "Unknown API endpoint."}, 404)
            else:
                root = self.app.web_root.resolve()
                path = (root / (unquote(url.path).lstrip("/") or "index.html")).resolve()
                if not path.is_relative_to(root) or not path.is_file():
                    self._json({"error": "Application assets not found. Run npm install && npm run build in the repository."}, 404)
                    return
                self._send(path.read_bytes(), mimetypes.guess_type(path)[0] or "application/octet-stream")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (KeyError, IndexError) as e:
            self._json({"error": str(e)}, 404)
        except (ValueError, OSError, TypeError) as e:
            self._json({"error": str(e)}, 400)

    def do_POST(self):
        if not self._local():
            return
        if self.path != "/api/sources":
            self._json({"error": "Unknown API endpoint."}, 404)
            return
        if self.headers.get("X-WarpSPH-Client") != "trajectory-viewer":
            self._json({"error": "Source registration requires the local viewer."}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                raise ValueError("Invalid source request length.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or not isinstance(data.get("path"), str):
                raise ValueError("Provide a local trajectory path.")
            with self.app.workers:
                result = self.app.add(open_source(data["path"]))
            self._json(result, 201)
        except (ValueError, OSError, KeyError, TypeError) as e:
            self._json({"error": str(e)}, 400)


def create_server(application, port=8765):
    return ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, application=application))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="HDF5 files, NPZ files, or snapshot directories")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", type=Path)
    args = parser.parse_args()
    try:
        app = Application(args.paths, args.web_root)
        server = create_server(app, args.port)
    except (OSError, ValueError) as e:
        parser.error(str(e))
    print(f"warpSPH Remote → http://127.0.0.1:{server.server_port}", flush=True)
    print("Trajectory inspection only. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
