"""Authenticated singleton companion. Always binds IPv4 loopback in this release."""

from __future__ import annotations
import argparse
from collections import OrderedDict
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid
from .catalogue import CATALOGUE, validate_launch
from .protocol import validate_packet

MAX_PACKET = 128 * 1024 * 1024
DEFAULT_ORIGINS = {
    "https://fluids.dev",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://localhost:5174",
}


def runtime_dir(path=None):
    root = (
        Path(path)
        if path
        else Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/warpsph-{os.getuid()}"))
        / "warpsph-remote"
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    st = root.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError(
            "Daemon runtime directory must be owned by this user and mode 0700."
        )
    return root


def descriptor(path=None):
    root = runtime_dir(path)
    p = root / "daemon.json"
    st = p.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError("Unsafe daemon descriptor permissions.")
    return json.loads(p.read_text())


class Conflict(ValueError):
    pass


class Manager:
    def __init__(self, root, python=None, origins=()):
        self.root = runtime_dir(root)
        self.python = str(Path(python or sys.executable).resolve())
        self.origins = DEFAULT_ORIGINS | set(origins)
        self.token = secrets.token_urlsafe(32)
        self.producer_token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.runs = OrderedDict()
        self.revision = 0
        self.closed = False

    def touch(self):
        self.revision += 1

    def register(self, data, key=None):
        if (
            not isinstance(data, dict)
            or not isinstance(data.get("name"), str)
            or not data["name"].strip()
            or len(data["name"]) > 160
        ):
            raise ValueError("A simulation needs a short display name.")
        with self.lock:
            if key:
                run = self.runs[key]
                if run.get("registered"):
                    raise Conflict("Run already has a producer.")
            else:
                if len(self.runs) >= 128:
                    raise Conflict(
                        "Session has 128 runs; restart the daemon to clear it."
                    )
                key = uuid.uuid4().hex
                run = dict(
                    id=key,
                    startedAt=time.time(),
                    status="starting",
                    sequence=0,
                    createdBy="simulation",
                )
                self.runs[key] = run
            run.update(
                name=data["name"],
                pid=data.get("pid"),
                registered=True,
                updatedAt=time.time(),
                capture=False,
                captureGeneration=0,
                stop=run.get("stop", False),
                snapshot=None,
                static=None,
                staticRevision=None,
                metadata=None,
                lease=None,
                leaseAt=0.0,
            )
            self.touch()
            return key

    def public(self, run):
        keys = (
            "id",
            "name",
            "startedAt",
            "updatedAt",
            "status",
            "pid",
            "step",
            "time",
            "dt",
            "particles",
            "scheme",
            "dimension",
            "sequence",
            "createdBy",
            "message",
            "launch",
            "registered",
        )
        row = {k: run[k] for k in keys if k in run}
        row["visualized"] = bool(
            run.get("lease") and time.monotonic() - run.get("leaseAt", 0) < 20
        )
        row["stale"] = time.time() - run.get("updatedAt", 0) > 10 and run.get(
            "status"
        ) not in ("completed", "failed", "stopped")
        return row

    def status(self, key, data):
        allowed = {
            "step",
            "time",
            "dt",
            "particles",
            "dimension",
            "scheme",
            "status",
            "message",
        }
        if not isinstance(data, dict) or set(data) - allowed:
            raise ValueError("Invalid simulation status.")
        for k in ("time", "dt"):
            if k in data and (
                type(data[k]) not in (float, int)
                or not __import__("math").isfinite(data[k])
            ):
                raise ValueError("Nonfinite status.")
        for k in ("step", "particles"):
            if k in data and (type(data[k]) is not int or data[k] < 0):
                raise ValueError("Invalid status count.")
        if data.get("status", "running") not in (
            "starting",
            "running",
            "completed",
            "failed",
            "stopped",
        ):
            raise ValueError("Invalid run state.")
        if "dimension" in data and data["dimension"] not in (2, 3):
            raise ValueError("Invalid dimension.")
        if "scheme" in data and (
            not isinstance(data["scheme"], str) or len(data["scheme"]) > 80
        ):
            raise ValueError("Invalid scheme.")
        if (
            not isinstance(data.get("message", ""), str)
            or len(data.get("message", "")) > 500
        ):
            raise ValueError("Status message too long.")
        with self.lock:
            r = self.runs[key]
            r.update(data, updatedAt=time.time())
            self.expire(r)
            self.touch()
            return dict(
                capture=bool(r.get("capture")),
                attached=bool(r.get("lease")),
                captureSequence=r.get("captureGeneration", 0),
                staticRevision=r.get("staticRevision"),
                stop=bool(r.get("stop")),
            )

    def expire(self, r):
        if r.get("lease") and time.monotonic() - r["leaseAt"] > 20:
            r.update(
                lease=None,
                capture=False,
                snapshot=None,
                static=None,
                staticRevision=None,
            )

    def attach(self, key, viewer):
        if not isinstance(viewer, str) or not 16 <= len(viewer) <= 80:
            raise ValueError("Invalid viewer session.")
        with self.lock:
            r = self.runs[key]
            self.expire(r)
            if not r.get("registered"):
                raise Conflict(
                    "The simulation is still starting. Attach once it registers."
                )
            for other in self.runs.values():
                self.expire(other)
                if other.get("lease") and other["lease"] != viewer:
                    raise Conflict("A viewer already owns the live connection.")
                if other is not r and other.get("lease") == viewer:
                    other.update(
                        lease=None,
                        capture=False,
                        snapshot=None,
                        static=None,
                        staticRevision=None,
                    )
            if r.get("status") in ("completed", "failed", "stopped") and not r.get(
                "snapshot"
            ):
                raise Conflict("This run has ended; attach while it is running.")
            if r.get("lease") != viewer:
                r["captureGeneration"] = r.get("captureGeneration", 0) + 1
            r.update(
                lease=viewer,
                leaseAt=time.monotonic(),
                capture=r.get("snapshot") is None,
            )
            self.touch()
            return self.public(r)

    def owned(self, key, viewer):
        r = self.runs[key]
        self.expire(r)
        if not viewer or r.get("lease") != viewer:
            raise Conflict("Attach this viewer before requesting live data.")
        r["leaseAt"] = time.monotonic()
        return r

    def upload(self, key, body, metadata, revision, generation):
        if len(body) < 8:
            raise ValueError("Incomplete snapshot envelope.")
        if len(body) > MAX_PACKET:
            raise ValueError("Snapshot exceeds its limit.")
        ns, nd = struct.unpack("<II", body[:8])
        if 8 + ns + nd != len(body) or not nd or ns > MAX_PACKET or nd > MAX_PACKET:
            raise ValueError("Invalid snapshot sizes.")
        for part in (body[8 : 8 + ns] if ns else None, body[8 + ns :]):
            if part is not None:
                validate_packet(part)
        if not isinstance(metadata, dict) or not revision or len(revision) > 80:
            raise ValueError("Snapshot metadata missing.")
        with self.lock:
            r = self.runs[key]
            self.expire(r)
            if (
                not r.get("lease")
                or not r.get("capture")
                or generation != r.get("captureGeneration")
            ):
                raise Conflict("No matching capture is requested.")
            if not ns and r.get("staticRevision") != revision:
                raise Conflict("Static arrays must accompany a new revision.")
            if ns:
                r["static"] = body[8 : 8 + ns]
            r.update(
                snapshot=body[8 + ns :],
                staticRevision=revision,
                metadata=metadata,
                sequence=r["sequence"] + 1,
                capture=False,
            )
            self.touch()

    def launch(self, data):
        spec = validate_launch(data)
        with self.lock:
            if any(
                r.get("process") and r["process"].poll() is None
                for r in self.runs.values()
            ):
                raise Conflict(
                    "A managed preset is already running. Stop it before starting another."
                )
            if len(self.runs) >= 128:
                raise Conflict("Run capacity reached.")
            key = uuid.uuid4().hex
            run_dir = self.root / "runs" / key
            run_dir.mkdir(parents=True, mode=0o700)
            spec_path = run_dir / "launch.json"
            spec_path.write_text(json.dumps(spec))
            output = open(run_dir / "simulation.log", "ab", buffering=0)
            env = {
                **os.environ,
                "WARPSPH_REMOTE_RUNTIME": str(self.root),
                "WARPSPH_REMOTE_RUN": key,
            }
            # Fixed executable/module/arguments. No browser command, import, path or shell input.
            p = subprocess.Popen(
                [self.python, "-m", "warpsph_remote.simulation_worker", str(spec_path)],
                env=env,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            output.close()
            case = next(c for c in CATALOGUE if c["id"] == spec["preset"])
            self.runs[key] = dict(
                id=key,
                name=case["name"],
                startedAt=time.time(),
                updatedAt=time.time(),
                status="starting",
                sequence=0,
                createdBy="daemon",
                launch=spec,
                process=p,
                pid=p.pid,
                registered=False,
                stop=False,
            )
            self.touch()
        threading.Thread(target=self._reap, args=(key, p), daemon=True).start()
        return self.public(self.runs[key])

    def _reap(self, key, p):
        code = p.wait()
        with self.lock:
            r = self.runs[key]
            if r.get("status") not in ("completed", "failed", "stopped"):
                r.update(
                    status=(
                        "stopped"
                        if r.get("stop")
                        else "failed" if code else "completed"
                    ),
                    message=f"Worker exited with code {code}. See its local simulation.log.",
                    updatedAt=time.time(),
                )
            self.touch()

    def stop(self, key):
        with self.lock:
            r = self.runs[key]
            r["stop"] = True
            p = r.get("process")
            if p and p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
            self.touch()

    def shutdown(self):
        self.closed = True
        for key, r in list(self.runs.items()):
            if r.get("process") and r["process"].poll() is None:
                self.stop(key)


class Handler(BaseHTTPRequestHandler):
    server_version = "warpSPHCompanion/1"

    def __init__(self, *args, manager, **kwargs):
        self.manager = manager
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass  # Never put bearer credentials or URL fragments in logs.

    def gate(self, producer=False, preflight=False):
        try:
            h = urlsplit("http://" + self.headers.get("Host", ""))
            valid = (
                h.hostname in ("127.0.0.1", "localhost")
                and h.port == self.server.server_port
                and not h.username
                and not h.password
            )
        except ValueError:
            valid = False
        if not valid:
            self.send_json({"error": "Invalid loopback host."}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in self.manager.origins:
            self.send_json({"error": "Viewer origin is not allowed."}, 403)
            return False
        token = self.manager.producer_token if producer else self.manager.token
        if not preflight and not hmac.compare_digest(
            self.headers.get("Authorization", "").encode("utf-8"),
            ("Bearer " + token).encode("ascii"),
        ):
            self.send_json({"error": "A valid daemon pairing token is required."}, 401)
            return False
        return True

    def send(self, body=b"", content_type="application/json", status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in self.manager.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header(
                "Access-Control-Expose-Headers",
                "X-Static-Revision, X-Snapshot-Sequence, X-Snapshot-Metadata",
            )
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, data, status=200):
        self.send(json.dumps(data, allow_nan=False).encode(), status=status)

    def body(self, limit=65536):
        n = int(self.headers.get("Content-Length", "0"))
        if not 0 < n <= limit:
            raise ValueError("Request body exceeds its limit.")
        return self.rfile.read(n)

    def json_body(self):
        data = json.loads(self.body())
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object.")
        return data

    def do_OPTIONS(self):
        if self.gate(preflight=True):
            self.send(
                status=204,
                headers={
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Viewer-Id, X-Static-Revision, X-Snapshot-Metadata, X-Capture-Generation",
                    "Access-Control-Allow-Private-Network": "true",
                    "Access-Control-Max-Age": "600",
                },
            )

    def do_GET(self):
        if not self.gate():
            return
        parts = urlsplit(self.path).path.strip("/").split("/")
        try:
            if parts == ["v1", "session"]:
                return self.send_json(
                    {
                        "version": 1,
                        "revision": self.manager.revision,
                        "presets": CATALOGUE,
                        "loopbackOnly": True,
                    }
                )
            if parts == ["v1", "runs"]:
                with self.manager.lock:
                    rows = [self.manager.public(r) for r in self.manager.runs.values()]
                return self.send_json({"revision": self.manager.revision, "runs": rows})
            if len(parts) == 4 and parts[:2] == ["v1", "runs"]:
                key, action = parts[2:]
                with self.manager.lock:
                    r = self.manager.owned(key, self.headers.get("X-Viewer-Id"))
                    if action == "snapshot":
                        if r.get("snapshot") is None:
                            return self.send(status=204)
                        body = r["snapshot"]
                        headers = {
                            "X-Snapshot-Sequence": str(r["sequence"]),
                            "X-Static-Revision": r["staticRevision"],
                            "X-Snapshot-Metadata": json.dumps(
                                r["metadata"], separators=(",", ":")
                            ),
                        }
                    elif action == "static":
                        body = r.get("static")
                        headers = {}
                    else:
                        raise KeyError("Unknown endpoint.")
                if body is None:
                    return self.send(status=204)
                return self.send(body, "application/octet-stream", headers=headers)
            self.send_json({"error": "Unknown endpoint."}, 404)
        except (KeyError, ValueError, OSError) as e:
            self.send_json({"error": str(e)}, 409 if isinstance(e, Conflict) else 400)

    def do_POST(self):
        parts = urlsplit(self.path).path.strip("/").split("/")
        producer = parts[:1] == ["producer"]
        if not self.gate(producer=producer):
            return
        try:
            if parts == ["producer", "runs"]:
                data = self.json_body()
                key = data.pop("id", None)
                return self.send_json({"id": self.manager.register(data, key)}, 201)
            if len(parts) == 3 and parts[0] == "producer":
                key, action = parts[1:]
                if action == "status":
                    return self.send_json(self.manager.status(key, self.json_body()))
                if action == "snapshot":
                    meta = json.loads(self.headers.get("X-Snapshot-Metadata", "{}"))
                    self.manager.upload(
                        key,
                        self.body(MAX_PACKET),
                        meta,
                        self.headers.get("X-Static-Revision"),
                        int(self.headers.get("X-Capture-Generation", "-1")),
                    )
                    return self.send_json({"accepted": True})
            if parts == ["v1", "runs"]:
                return self.send_json(self.manager.launch(self.json_body()), 201)
            if len(parts) == 4 and parts[:2] == ["v1", "runs"]:
                key, action = parts[2:]
                data = self.json_body()
                viewer = self.headers.get("X-Viewer-Id")
                if action == "attach":
                    return self.send_json(self.manager.attach(key, viewer))
                if action == "stop":
                    self.manager.stop(key)
                    return self.send_json({"stopping": True})
                with self.manager.lock:
                    r = self.manager.owned(key, viewer)
                    if action == "ack":
                        if (
                            data.get("sequence") != r["sequence"]
                            or r.get("snapshot") is None
                        ):
                            raise Conflict("Snapshot acknowledgement is stale.")
                        r["captureGeneration"] = r.get("captureGeneration", 0) + 1
                        r.update(
                            snapshot=None,
                            capture=r.get("status")
                            not in ("completed", "failed", "stopped"),
                        )
                    elif action == "detach":
                        r.update(
                            lease=None,
                            capture=False,
                            snapshot=None,
                            static=None,
                            staticRevision=None,
                        )
                    else:
                        raise KeyError("Unknown endpoint.")
                return self.send_json({"ok": True})
            self.send_json({"error": "Unknown endpoint."}, 404)
        except (KeyError, ValueError, OSError, TypeError) as e:
            self.send_json({"error": str(e)}, 409 if isinstance(e, Conflict) else 400)


def serve(root=None, port=8766, python=None, origins=(), incidental=False, ready=None):
    root = runtime_dir(root)
    lock = os.open(root / "daemon.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return False
    except OSError:
        os.close(lock)
        raise
    manager = server = None
    previous = {}
    try:
        manager = Manager(root, python, origins)
        server = ThreadingHTTPServer(
            ("127.0.0.1", port), partial(Handler, manager=manager)
        )
        server.daemon_threads = True
        info = dict(
            version=1,
            pid=os.getpid(),
            endpoint=f"http://127.0.0.1:{server.server_port}",
            token=manager.token,
            producerToken=manager.producer_token,
        )
        temp = root / f".descriptor-{os.getpid()}"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(info, output)
        temp.replace(root / "daemon.json")
        if ready:
            ready(info)
        if not incidental:
            print(
                f"warpSPH companion: {info['endpoint']}\nPairing token: {manager.token}",
                flush=True,
            )

        def stop(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()

        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, stop)
        server.serve_forever(poll_interval=0.2)
        return True
    finally:
        if manager:
            manager.shutdown()
        if server:
            server.server_close()
        try:
            if descriptor(root).get("pid") == os.getpid():
                (root / "daemon.json").unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        os.close(lock)


def ensure_daemon(root=None, python=None, port=8766):
    from urllib.request import Request, urlopen

    root = runtime_dir(root)

    def alive():
        try:
            info = descriptor(root)
            with urlopen(
                Request(
                    info["endpoint"] + "/v1/session",
                    headers={"Authorization": "Bearer " + info["token"]},
                ),
                timeout=1,
            ):
                return info
        except (OSError, ValueError, KeyError):
            return None

    info = alive()
    if info:
        return info
    log = open(root / "daemon.log", "ab", buffering=0)
    command = [
        sys.executable,
        "-m",
        "warpsph_remote.daemon",
        "--runtime",
        str(root),
        "--incidental",
        "--port",
        str(port),
        "--python",
        python or sys.executable,
    ]
    subprocess.Popen(
        command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    )
    log.close()
    until = time.monotonic() + 10
    while time.monotonic() < until:
        info = alive()
        if info:
            return info
        time.sleep(0.1)
    raise RuntimeError("Local daemon did not start. Inspect its daemon.log.")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runtime", type=Path)
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--python", help="Trusted simulation Python executable (CLI only).")
    p.add_argument("--origin", action="append", default=[])
    p.add_argument("--incidental", action="store_true", help=argparse.SUPPRESS)
    a = p.parse_args()
    if not serve(a.runtime, a.port, a.python, a.origin, a.incidental):
        info = descriptor(a.runtime)
        if not a.incidental:
            print(
                f"Daemon already running: {info['endpoint']}\nPairing token: {info['token']}"
            )


if __name__ == "__main__":
    main()
