"""Authenticated companion: loopback by default, explicit HTTPS remote viewer mode."""

from __future__ import annotations
import argparse
from collections import OrderedDict
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl
import hmac
import json
import math
import re
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
from urllib.parse import urlsplit, parse_qs
import uuid
from .catalogue import armed_video, CATALOGUE, validate_launch
from .configuration import query_solver
from .protocol import DEFAULT_SNAPSHOT_BYTES, validate_packet
from .pairing_token import persistent_token
from .networking import RemoteOptions, TLSViewerServer, hostname, authority

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


class ViewerConflict(Conflict):
    code = "viewer_conflict"


class Manager:
    def __init__(self, root, python=None, origins=(),
                 max_snapshot_bytes=DEFAULT_SNAPSHOT_BYTES):
        if type(max_snapshot_bytes) is not int or not 1 <= max_snapshot_bytes < 2**32:
            raise ValueError("Snapshot budget must be positive and below 4 GiB (WPR1 envelope limit).")
        self.max_snapshot_bytes = max_snapshot_bytes
        self.root = runtime_dir(root)
        self.python = str(Path(python or sys.executable).resolve())
        self.origins = DEFAULT_ORIGINS | set(origins)
        self.token = secrets.token_urlsafe(32)
        self.producer_token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.runs = OrderedDict()
        self.revision = 0
        self.closed = False
        self.configuration_cache = {}
        self.catalogue = None

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
        capabilities=data.get('capabilities',[])
        if not isinstance(capabilities,list) or len(capabilities)>32 or any(not isinstance(v,str) or len(v)>80 for v in capabilities):
            raise ValueError('Invalid producer capabilities.')
        initial_video=armed_video(data['videoCapture']) if data.get('videoCapture') is not None else None
        recovery = data.get("reconnect", False)
        if any(type(data.get(k, False)) is not bool for k in ("reconnect", "paused", "managed")):
            raise ValueError("Invalid producer recovery flags.")
        if recovery and (not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{32}", key)
                or type(data.get("pid")) is not int or data["pid"] <= 0
                or type(data.get("startedAt")) not in (int, float)
                or not math.isfinite(data["startedAt"]) or data["startedAt"] <= 0):
            raise ValueError("Invalid producer recovery identity.")
        with self.lock:
            if key and key in self.runs:
                run = self.runs[key]
                if run.get("registered"):
                    if recovery and run.get("pid") == data["pid"]:
                        return key  # Idempotent retry after a lost registration response.
                    raise Conflict("Run already has a producer.")
            else:
                if key and not recovery:
                    raise ValueError("Unknown managed run.")
                if len(self.runs) >= 128:
                    raise Conflict("Session has 128 runs; restart the daemon to clear it.")
                key = key if recovery else uuid.uuid4().hex
                run = dict(id=key, startedAt=data["startedAt"] if recovery else time.time(),
                    status="paused" if recovery and data.get("paused") else "starting",
                    sequence=0, createdBy="daemon" if recovery and data.get("managed") else "simulation",
                    recovered=recovery,
                    pause=bool(recovery and data.get("paused")))
                self.runs[key] = run
            if initial_video is not None:
                run['video']=initial_video
                run['pause']=True
            if recovery and isinstance(data.get('video'), dict) and data['video'].get('active'):
                interval = data['video'].get('interval',.04)
                if type(interval) not in (int,float) or not math.isfinite(interval) or interval<=0:
                    raise ValueError('Invalid recovered video interval.')
                run['video'] = dict(active=True, interval=interval, fps=data['video'].get('fps',30), armed=data['video'].get('armed',False), nextTime=-1, ackTime=-1, ackStep=-1, orphaned=True)
            run.update(
                name=data["name"],
                pid=data.get("pid"),
                registered=True,
                capabilities=capabilities,
                updatedAt=time.time(),
                capture=False,
                captureGeneration=0,
                stop=run.get("stop", False),
                pause=run.get("pause", False),
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
            "performance",
            "resources",
            "streamPaused", "video",
            "captureInterval",
        )
        row = {k: run[k] for k in keys if k in run}
        row["pauseRequested"] = bool(run.get("pause"))
        row["configurationAvailable"] = bool(run.get("configuration"))
        row["videoSupported"] = "synchronizedVideo" in run.get("capabilities",[])
        if run.get("recording"):
            row["recording"] = {"enabled": True, "mode": run["recording"]["mode"]}
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
            "recording",
            "performance",
            "resources", "videoFinishing",
        }
        if not isinstance(data, dict) or set(data) - allowed:
            raise ValueError("Invalid simulation status.")
        from .telemetry import validate_telemetry
        validate_telemetry(data)
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
            "paused",
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
        if "videoFinishing" in data and type(data["videoFinishing"]) is not bool:
            raise ValueError("Invalid final capture flag.")
        if "recording" in data:
            recording = data["recording"]
            if (not isinstance(recording, dict) or set(recording) - {"path", "mode", "domain", "name"}
                    or recording.get("mode") not in ("trajectory", "states")
                    or not isinstance(recording.get("path"), str)
                    or not Path(recording["path"]).is_absolute()):
                raise ValueError("Invalid producer recording descriptor.")
        with self.lock:
            r = self.runs[key]
            r.update(data, updatedAt=time.time())
            video = r.get("video", {})
            if video.get("active") and data.get("videoFinishing") and video.get("ackTime", -1) < data.get("time", 0):
                video["nextTime"] = -1
                if r.get("lease") and r.get("snapshot") is None:
                    r["capture"] = True
            self.expire(r)
            self.touch()
            return dict(
                capture=bool(r.get("capture")) and not r.get("streamPaused", False),
                captureInterval=0 if r.get("video",{}).get("active") else r.get("captureInterval", 0.5),
                video=r.get("video"),
                attached=bool(r.get("lease")),
                captureSequence=r.get("captureGeneration", 0),
                staticRevision=r.get("staticRevision"),
                maxSnapshotBytes=self.max_snapshot_bytes,
                stop=bool(r.get("stop")),
                pause=bool(r.get("pause")),
                historyRequest=(r.get("historyPending") or {}).get("request"),
            )

    def viewer_lost(self, r):
        video = r.get("video", {})
        if video.get("active"):
            # Recorded runs can recover their video offline; otherwise keep the
            # integrator at a safe boundary until a viewer explicitly releases it.
            if r.get("recording"):
                video["active"] = False
            else:
                video["orphaned"] = True

    def expire(self, r):
        if r.get("lease") and time.monotonic() - r["leaseAt"] > 20:
            self.viewer_lost(r)
            r.update(
                lease=None,
                capture=False,
                snapshot=None,
                static=None,
                staticRevision=None,
            )

    def attach(self, key, viewer, takeover=False):
        if type(takeover) is not bool:
            raise ValueError("Takeover must be a boolean.")
        if not isinstance(viewer, str) or not 16 <= len(viewer) <= 80:
            raise ValueError("Invalid viewer session.")
        with self.lock:
            r = self.runs[key]
            self.expire(r)
            if not r.get("registered"):
                raise Conflict(
                    "The simulation is still starting. Attach once it registers."
                )
            # Validate the destination before releasing any existing connection.
            if r.get("status") in ("completed", "failed", "stopped") and not r.get("snapshot") and r.get("lease") != viewer:
                raise Conflict("This run has ended; attach while it is running.")
            for other in self.runs.values():
                self.expire(other)
            if not takeover and any(other.get("lease") and other["lease"] != viewer
                                    for other in self.runs.values()):
                raise ViewerConflict("A viewer already owns the live connection.")
            for other in self.runs.values():
                if other is not r and other.get("lease") and (takeover or other["lease"] == viewer):
                    self.viewer_lost(other)
                    other.update(lease=None, capture=False, snapshot=None, static=None,
                                 staticRevision=None, metadata=None)
            if r.get("lease") != viewer:
                if r.get('video',{}).get('active'):
                    r['video']['orphaned']=True
                r.update(streamPaused=False, captureInterval=0.5)
                # Invalidate producer uploads prepared for the displaced lease.
                r["captureGeneration"] = r.get("captureGeneration", 0) + 1
                if r.get("snapshot") is None:
                    # A paused publisher must reissue its static revision, allowing
                    # a fresh viewer to capture even at the same safe boundary.
                    r.update(static=None, staticRevision=None, metadata=None)
                # Otherwise retain the immutable pending snapshot + matching static
                # arrays, including a final snapshot from a completed simulation.
            r.update(
                lease=viewer,
                leaseAt=time.monotonic(),
                capture=r.get("snapshot") is None and not r.get("streamPaused", False),
            )
            self.touch()
            return self.public(r)

    def video_capture(self, key, viewer, data):
        if not isinstance(data, dict) or set(data) - {'active', 'interval', 'adopt'} or type(data.get('active')) is not bool:
            raise ValueError('Invalid video capture settings.')
        if 'adopt' in data and type(data['adopt']) is not bool:
            raise ValueError('Video adoption flag must be boolean.')
        interval = data.get('interval', .04)
        if type(interval) not in (int,float) or not math.isfinite(interval) or interval <= 0:
            raise ValueError('Video simulation interval must be positive.')
        with self.lock:
            r = self.owned(key, viewer)
            if data['active'] and 'synchronizedVideo' not in r.get('capabilities',[]):
                raise Conflict('Restart this simulation with an updated adapter to synchronize video capture.')
            if data['active'] and r.get('status') in ('completed','failed','stopped'):
                raise Conflict('The simulation has ended; export its recorded trajectory instead.')
            if data.get('adopt'):
                initial_pending=(r.get('snapshot') is not None and (r.get('metadata') or {}).get('videoArmed')
                    and r.get('video',{}).get('ackTime',-1)<(r.get('metadata') or {}).get('time',0))
                if not data['active'] or not (r.get('video',{}).get('armed') or initial_pending):
                    raise Conflict('This run has no armed initial video frame.')
                # Keep its pending initial snapshot and generation: the viewer
                # must encode this exact state before acknowledging it.
                r['video'].update(active=True,armed=False,orphaned=False,interval=interval)
                self.touch()
                return self.public(r)
            r['video'] = dict(active=data['active'], interval=interval, nextTime=-1, ackTime=-1, ackStep=-1, orphaned=False)
            r['captureGeneration'] = r.get('captureGeneration',0)+1
            r.update(snapshot=None, static=None, staticRevision=None, streamPaused=False,
                capture=data['active'] or r.get('status') not in ('completed','failed','stopped'))
            self.touch()
            return self.public(r)

    def streaming(self, key, viewer, data):
        if not isinstance(data, dict) or set(data) - {'paused', 'interval'}:
            raise ValueError('Invalid streaming settings.')
        if 'paused' in data and type(data['paused']) is not bool:
            raise ValueError('Invalid transfer pause setting.')
        if 'interval' in data and (type(data['interval']) not in (int,float)
                or not math.isfinite(data['interval']) or data['interval'] < 0):
            raise ValueError('Capture interval must be finite and nonnegative.')
        with self.lock:
            r = self.owned(key, viewer)
            if r.get('video',{}).get('active'):
                raise Conflict('Finish video capture before changing live transfer settings.')
            if 'paused' in data and data['paused'] != r.get('streamPaused', False):
                r['captureGeneration'] = r.get('captureGeneration',0) + 1
                r.update(streamPaused=data['paused'], capture=not data['paused'] and
                    r.get('snapshot') is None and r.get('status') not in ('completed','stopped','failed'))
            if 'interval' in data:
                r['captureInterval'] = float(data['interval'])
            self.touch()
            return self.public(r)

    def owned(self, key, viewer):
        r = self.runs[key]
        self.expire(r)
        if viewer and r.get("lease") and r["lease"] != viewer:
            raise ViewerConflict("The live connection was taken over by another viewer.")
        if not viewer or r.get("lease") != viewer:
            raise Conflict("Attach this viewer before requesting live data.")
        r["leaseAt"] = time.monotonic()
        return r

    def upload(self, key, body, metadata, revision, generation):
        if len(body) < 8:
            raise ValueError("Incomplete snapshot envelope.")
        if len(body) > self.max_snapshot_bytes:
            raise ValueError("Snapshot exceeds the daemon memory budget; increase --max-snapshot-mib.")
        ns, nd = struct.unpack("<II", body[:8])
        if (8 + ns + nd != len(body) or not nd
                or ns > self.max_snapshot_bytes or nd > self.max_snapshot_bytes):
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

    def available_cases(self, refresh=False):
        if refresh:
            self.catalogue = None
            self.configuration_cache.clear()
        if self.catalogue is None:
            try:
                result = query_solver(self.python, '--catalogue', {})
            except ValueError as error:
                result = {'error': str(error)}
            self.catalogue = result.get('presets') or [{**c, 'available': False, 'configurable': False,
                'unavailableReason': result.get('error', 'Could not discover installed cases.')} for c in CATALOGUE]
        return self.catalogue

    def launch(self, data):
        spec = validate_launch(data, self.available_cases())
        if 'configuration' in spec:
            checked = query_solver(self.python, '--validate', spec)
            if not checked.get('valid'):
                raise ValueError(checked.get('error', 'Invalid solver configuration.'))
        with self.lock:
            if any(
                (r.get("process") and r["process"].poll() is None) or
                (r.get("recovered") and r.get("createdBy") == "daemon" and
                 r.get("status") in ("starting", "running", "paused") and
                 time.time() - r.get("updatedAt", 0) < 10)
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
                [
                    self.python,
                    str(Path(__file__).with_name("simulation_worker.py")),
                    str(spec_path),
                ],
                env=env,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            output.close()
            case = next(c for c in self.available_cases() if c["id"] == spec["preset"])
            self.runs[key] = dict(
                id=key,
                name=case["name"],
                startedAt=time.time(),
                updatedAt=time.time(),
                status="starting",
                sequence=0,
                createdBy="daemon",
                launch=spec,
                **({"video":armed_video(spec["video"])} if "video" in spec else {}),
                process=p,
                pid=p.pid,
                registered=False,
                stop=False,
                pause=bool(spec.get("paused")),
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

    def pause(self, key, paused):
        with self.lock:
            r = self.runs[key]
            if not r.get("registered") or r.get("status") not in ("starting", "running", "paused"):
                raise Conflict("Only an active simulation can be paused or resumed.")
            r["pause"] = paused
            self.touch()

    def history(self, key, operation, index=None, field=None, timeout=8):
        # Browser input selects frames, never a filesystem path.
        if operation not in ("metadata", "frame") or (operation == "frame" and
                (type(index) is not int or index < 0 or not isinstance(field, str) or len(field) > 80)):
            raise ValueError("Invalid history request.")
        with self.lock:
            r = self.runs[key]
            recording = r.get("recording")
            if not recording:
                raise Conflict("This simulation has trajectory export disabled.")
            terminal = r.get("status") in ("completed", "stopped", "failed")
            if not terminal:
                if r.get("historyPending"):
                    raise Conflict("A recorded frame is already being read; retry shortly.")
                pending = {"request": dict(id=uuid.uuid4().hex, operation=operation, index=index, field=field),
                           "event": threading.Event()}
                r["historyPending"] = pending
        if terminal:
            from .recordings import read_recording
            return read_recording(recording, operation, index, field)
        try:
            if not pending["event"].wait(timeout):
                raise Conflict("Waiting for a simulation step boundary; retry history shortly.")
            if pending.get("error"):
                raise Conflict(pending["error"])
            return pending["result"]
        finally:
            with self.lock:
                if r.get("historyPending") is pending:
                    r.pop("historyPending", None)

    def history_result(self, key, request_id, body, content_type):
        if content_type == "application/octet-stream":
            validate_packet(body)
        elif content_type != "application/json":
            raise ValueError("Invalid history response type.")
        with self.lock:
            pending = self.runs[key].get("historyPending")
            if not pending or pending["request"]["id"] != request_id:
                raise Conflict("History request has expired.")
            if content_type == "application/json":
                value = json.loads(body)
                if "error" in value:
                    pending["error"] = str(value["error"])[:500]
            pending["result"] = (body, content_type)
            pending["event"].set()

    def stop(self, key):
        with self.lock:
            r = self.runs[key]
            r["stop"] = True
            p = r.get("process")
            if p and p.poll() is None:
                if not r.get("registered"):
                    os.killpg(p.pid, signal.SIGTERM)
                else:
                    def terminate_if_stuck():
                        try:
                            p.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            if p.poll() is None:
                                try:
                                    os.killpg(p.pid, signal.SIGTERM)
                                except ProcessLookupError:
                                    pass
                    threading.Thread(target=terminate_if_stuck, daemon=True).start()
            self.touch()

    def shutdown(self, *, stop_runs=True):
        self.closed = True
        if not stop_runs:
            return
        for key, r in list(self.runs.items()):
            if r.get("process") and r["process"].poll() is None:
                self.stop(key)


class Handler(BaseHTTPRequestHandler):
    server_version = "warpSPHCompanion/1"

    def __init__(self, *args, manager, remote=False, allowed_hosts=(), **kwargs):
        self.manager = manager
        self.remote = remote
        self.allowed_hosts = set(allowed_hosts) if remote else {"127.0.0.1","localhost","::1"}
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass  # Never put bearer credentials or URL fragments in logs.

    def gate(self, producer=False, preflight=False):
        try:
            h = urlsplit("http://" + self.headers.get("Host", ""))
            valid = (
                len(self.headers.get_all('Host',[]))==1
                and hostname(h.hostname or '') in self.allowed_hosts
                and (h.port or (443 if self.remote else 80)) == self.server.server_port
                and not h.username and not h.password
                and not h.path and not h.query and not h.fragment
            )
        except ValueError:
            valid = False
        if not valid:
            self.send_json({"error": "Invalid companion host."}, 403)
            return False
        if self.remote and producer:
            self.send_json({'error':'Producer endpoints are available only on the loopback listener.'},403)
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in self.manager.origins:
            self.send_json({"error": "Viewer origin is not allowed."}, 403)
            return False
        token = self.manager.remote_token if self.remote else (self.manager.producer_token if producer else self.manager.token)
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
            # Each write has a stall deadline on TLS sockets, rather than a
            # total-frame deadline that penalizes a steadily progressing link.
            view=memoryview(body)
            for start in range(0,len(view),64*1024):
                self.wfile.write(view[start:start+64*1024])
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def send_json(self, data, status=200):
        self.send(json.dumps(data, allow_nan=False).encode(), status=status)

    def body(self, limit=65536):
        n = int(self.headers.get("Content-Length", "0"))
        if not 0 < n <= limit:
            raise ValueError("Request body exceeds its limit.")
        return self.rfile.read(n)

    def json_body(self, limit=65536):
        data = json.loads(self.body(limit))
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object.")
        return data

    def do_OPTIONS(self):
        if self.gate(producer=urlsplit(self.path).path.startswith("/producer/"),preflight=True):
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
                        "presets": self.manager.available_cases(refresh=parse_qs(urlsplit(self.path).query).get("refresh") == ["1"]),
                        "loopbackOnly": not self.remote,
                        "transport": "https" if self.remote else "http",
                        "maxSnapshotBytes": self.manager.max_snapshot_bytes,
                        "features": ["pause", "recordedHistory", "configuration", "viewerTakeover", "producerRecovery", "streaming", "configurationInspection", "synchronizedVideo", "videoFromStart"],
                    }
                )
            if parts == ["v1", "configuration"]:
                query = parse_qs(urlsplit(self.path).query)
                spec = validate_launch({'preset': query.get('preset', [''])[0],
                    **({'scheme': query['scheme'][0]} if 'scheme' in query else {})}, self.manager.available_cases())
                key = (spec['preset'], spec['scheme'])
                if key not in self.manager.configuration_cache:
                    self.manager.configuration_cache[key] = query_solver(self.manager.python, '--describe', spec)
                return self.send_json(self.manager.configuration_cache[key])
            if parts == ["v1", "runs"]:
                with self.manager.lock:
                    rows = [self.manager.public(r) for r in self.manager.runs.values()]
                return self.send_json({"revision": self.manager.revision, "runs": rows})
            if len(parts) in (4, 5) and parts[:2] == ["v1", "runs"] and parts[3] == "history":
                query = parse_qs(urlsplit(self.path).query)
                operation = "frame" if len(parts) == 5 and parts[4] == "frame" else "metadata"
                if len(parts) == 5 and parts[4] != "frame":
                    raise ValueError("Unknown history endpoint.")
                index = int(query.get("index", ["-1"])[0]) if operation == "frame" else None
                body, kind = self.manager.history(parts[2], operation, index, query.get("field", ["densities"])[0])
                return self.send(body, kind)
            if len(parts) == 4 and parts[:2] == ["v1", "runs"]:
                key, action = parts[2:]
                if action == "configuration":
                    with self.manager.lock:
                        configuration = self.manager.runs[key].get("configuration")
                    if configuration is None:
                        raise Conflict("The simulation has not published its configuration yet.")
                    return self.send_json(configuration)
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
            self.send_json({"error": str(e), **({"code": e.code} if isinstance(e, ViewerConflict) else {})},
                           409 if isinstance(e, Conflict) else 400)

    def do_POST(self):
        parts = urlsplit(self.path).path.strip("/").split("/")
        producer = parts[:1] == ["producer"]
        if not self.gate(producer=producer):
            return
        try:
            if parts == ["producer", "runs"]:
                data = self.json_body()
                key = data.pop("id", None)
                key = self.manager.register(data, key)
                return self.send_json({"id": key, "startedAt": self.manager.runs[key]["startedAt"], "video": self.manager.runs[key].get("video"), "pause":bool(self.manager.runs[key].get("pause")),
                    "features": ["telemetry", "producerRecovery", "bufferedCapture", "configurationInspection", "synchronizedVideo"]}, 201)
            if len(parts) == 3 and parts[0] == "producer":
                key, action = parts[1:]
                if action == "configuration":
                    configuration = self.json_body(1024*1024)
                    json.dumps(configuration, allow_nan=False)
                    with self.manager.lock:
                        self.manager.runs[key]["configuration"] = configuration
                    return self.send_json({"accepted": True})
                if action == "status":
                    return self.send_json(self.manager.status(key, self.json_body()))
                if action == "history":
                    self.manager.history_result(key, self.headers.get("X-History-Request"),
                        self.body(self.manager.max_snapshot_bytes), self.headers.get("Content-Type"))
                    return self.send_json({"accepted": True})
                if action == "snapshot":
                    meta = json.loads(self.headers.get("X-Snapshot-Metadata", "{}"))
                    self.manager.upload(
                        key,
                        self.body(self.manager.max_snapshot_bytes),
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
                    if not isinstance(data, dict) or set(data) - {"takeover"}:
                        raise ValueError("Invalid attachment request.")
                    return self.send_json(self.manager.attach(key, viewer, data.get("takeover", False)))
                if action == "video":
                    return self.send_json(self.manager.video_capture(key, viewer, data))
                if action == "stream":
                    return self.send_json(self.manager.streaming(key, viewer, data))
                if action in ("pause", "resume"):
                    self.manager.pause(key, action == "pause")
                    return self.send_json({"pauseRequested": action == "pause"})
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
                        video = r.get('video',{})
                        if video.get('active'):
                            meta = r.get('metadata') or {}
                            video.update(ackTime=meta.get('time',0), ackStep=meta.get('step',0),
                                nextTime=meta.get('time',0)+video['interval'])
                        r["captureGeneration"] = r.get("captureGeneration", 0) + 1
                        r.update(
                            snapshot=None,
                            capture=not r.get("streamPaused", False) and r.get("status")
                            not in ("completed", "failed", "stopped"),
                        )
                    elif action == "detach":
                        self.manager.viewer_lost(r)
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
            self.send_json({"error": str(e), **({"code": e.code} if isinstance(e, ViewerConflict) else {})},
                           409 if isinstance(e, Conflict) else 400)


def serve(root=None, port=8766, python=None, origins=(), incidental=False, ready=None,
          max_snapshot_bytes=DEFAULT_SNAPSHOT_BYTES, remote=None):
    if incidental and remote is not None:
        raise ValueError('Incidental startup cannot enable remote listening.')
    if remote is not None:
        remote=remote.validated()
        tls_context=remote.context()  # Reject unusable TLS before binding any listener.
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
    manager = server = remote_server = None
    remote_thread = None
    previous = {}
    try:
        manager = Manager(root, python, origins, max_snapshot_bytes)
        server = ThreadingHTTPServer(
            ("127.0.0.1", port), partial(Handler, manager=manager)
        )
        if remote is not None:
            manager.remote_token=secrets.token_urlsafe(32)
            remote_server=TLSViewerServer((remote.host,remote.port),partial(Handler,manager=manager,remote=True,allowed_hosts=remote.names),tls_context)
        manager.token = persistent_token()
        server.daemon_threads = True
        info = dict(
            version=1,
            pid=os.getpid(),
            endpoint=f"http://127.0.0.1:{server.server_port}",
            token=manager.token,
            producerToken=manager.producer_token,
            maxSnapshotBytes=manager.max_snapshot_bytes,
        )
        if remote_server:
            info['remote']=dict(endpoint='https://'+authority(remote.names[0],remote_server.server_port),token=manager.remote_token)
        temp = root / f".descriptor-{os.getpid()}"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(info, output)
        temp.replace(root / "daemon.json")
        if remote_server:
            remote_thread=threading.Thread(target=remote_server.serve_forever,kwargs={'poll_interval':.2},daemon=True)
            remote_thread.start()
        if ready:
            ready(info)
        if not incidental:
            print(
                f"warpSPH companion: {info['endpoint']}\nPairing token: {manager.token}",
                flush=True,
            )
            if remote_server:
                print(f"Remote viewer: {info['remote']['endpoint']}\nRemote pairing token: {manager.remote_token}\nRemote token lasts until daemon restart; producer access remains loopback-only.",flush=True)

        def stop(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()

        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, stop)
        server.serve_forever(poll_interval=0.2)
        return True
    finally:
        if manager:
            manager.shutdown(stop_runs=False)
        if remote_server:
            if remote_thread:
                remote_server.shutdown()
                remote_thread.join(timeout=3)
            remote_server.server_close()
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


def pairing_command(root=None, *, rotate=False):
    """Read an active credential, or manage the persistent one without starting a daemon."""
    root = runtime_dir(root)
    lock = os.open(root / 'daemon.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if rotate:
                raise ValueError('Stop this daemon before rotating its pairing token.')
            token = descriptor(root)['token']
            # Preserve the current credential during the first upgrade from session tokens.
            persistent_token(initial=token)
            return token
        return persistent_token(rotate=rotate)
    finally:
        os.close(lock)


def remote_pairing_command(root=None):
    root=runtime_dir(root)
    lock=os.open(root/'daemon.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            try:return descriptor(root)['remote']['token']
            except (OSError,ValueError,KeyError):pass
        raise ValueError('No active HTTPS remote listener at this runtime.')
    finally:os.close(lock)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runtime", type=Path)
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--python", help="Trusted simulation Python executable (CLI only).")
    p.add_argument("--origin", action="append", default=[])
    p.add_argument("--max-snapshot-mib", type=int, default=128,
                   help="Memory budget per buffered live snapshot in MiB (default: 128; 1–4095).")
    p.add_argument('--remote-host',help='Explicit HTTPS viewer bind IP, e.g. 192.168.1.20 or 0.0.0.0. Never enabled by simulations.')
    p.add_argument('--remote-port',type=int,default=8767,help='HTTPS viewer port (default: 8767); loopback uses --port.')
    p.add_argument('--remote-name',action='append',default=[],help='Allowed IP/DNS Host name matching the certificate. Required for wildcard binds; repeat for aliases.')
    p.add_argument('--tls-cert',type=Path,help='PEM certificate chain for explicit remote mode.')
    p.add_argument('--tls-key',type=Path,help='PEM private key for explicit remote mode.')

    p.add_argument("--incidental", action="store_true", help=argparse.SUPPRESS)
    credential = p.add_mutually_exclusive_group()
    credential.add_argument('--show-remote-token', action='store_true', help='Print the active remote listener token without starting a daemon.')
    credential.add_argument('--show-token', action='store_true', help='Print the current pairing token without starting a daemon.')
    credential.add_argument('--rotate-token', action='store_true', help='Replace the persistent pairing token while this daemon is stopped.')
    a = p.parse_args()
    if not 1 <= a.max_snapshot_mib <= 4095:
        p.error("--max-snapshot-mib must be 1–4095 (WPR1 envelope limit: below 4 GiB).")
    remote=None
    remote_flags=a.remote_host is not None or a.tls_cert is not None or a.tls_key is not None or bool(a.remote_name) or a.remote_port!=8767
    if remote_flags:
        if a.incidental:
            p.error('Incidental startup cannot enable remote listening.')
        if not a.remote_host or not a.tls_cert or not a.tls_key:
            p.error('Remote mode requires --remote-host, --tls-cert and --tls-key together.')
        if not 1<=a.remote_port<=65535:
            p.error('--remote-port must be 1–65535.')
        try:remote=RemoteOptions(a.remote_host,a.remote_port,a.tls_cert,a.tls_key,tuple(a.remote_name)).validated()
        except ValueError as error:p.error(str(error))
    if a.show_remote_token:
        if a.incidental:p.error('Incidental startup cannot print a remote pairing token.')
        try:print(remote_pairing_command(a.runtime))
        except (OSError,ValueError,KeyError):p.error('No active HTTPS remote listener at this runtime.')
        return
    if a.show_token or a.rotate_token:
        try:
            print(pairing_command(a.runtime, rotate=a.rotate_token))
        except (OSError, ValueError, KeyError) as error:
            p.error(str(error))
        return
    try:
        started=serve(a.runtime,a.port,a.python,a.origin,a.incidental,
            max_snapshot_bytes=a.max_snapshot_mib*1024*1024,remote=remote)
    except (OSError,ValueError) as error:p.error(str(error))
    if not started:
        info = descriptor(a.runtime)
        if remote is not None:
            p.error('A daemon is already running. Stop/restart it explicitly to change remote listener settings; it was not modified.')
        if not a.incidental:
            persistent_token(initial=info["token"])
            print(
                f"Daemon already running: {info['endpoint']}\nPairing token: {info['token']}"
            )


if __name__ == "__main__":
    main()
