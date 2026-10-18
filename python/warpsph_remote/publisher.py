"""Optional simulation-side resident adapter. No rendering and no Warp import."""

from __future__ import annotations
import hashlib
import json
import os
import struct
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import numpy as np
from .daemon import ensure_daemon, descriptor
from .protocol import encode_frame


class SimulationStopped(Exception):
    pass


def numpy_array(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value)


class SimulationPublisher:
    def __init__(self, name, *, runtime=None, autostart=True, interval=0.5):
        self.name = name
        self.info = ensure_daemon(runtime) if autostart else descriptor(runtime)
        self.interval = interval
        self.closed = threading.Event()
        self.stopping = threading.Event()
        self.pausing = threading.Event()
        self.history_request = None
        self.history_pending = None
        self.history_seen = None
        self.lock = threading.Lock()
        self.last_error = ""
        self.capture_target = 0
        self.captured = 0
        self.static_revision = None
        self.pending = None
        self.meta = {
            "status": "starting",
            "step": 0,
            "particles": 0,
            "time": 0.0,
            "dt": 0.0,
        }
        body = {"name": name, "pid": os.getpid()}
        if os.environ.get("WARPSPH_REMOTE_RUN"):
            body["id"] = os.environ["WARPSPH_REMOTE_RUN"]
        self.id = self._request("/producer/runs", body)["id"]
        self.thread = threading.Thread(
            target=self._loop, name="warpsph-companion-publisher", daemon=True
        )
        self.thread.start()

    def _request(self, path, data, headers=None):
        raw = (
            data
            if isinstance(data, bytes)
            else json.dumps(data, allow_nan=False).encode()
        )
        req = Request(
            self.info["endpoint"] + path,
            data=raw,
            headers={
                "Authorization": "Bearer " + self.info["producerToken"],
                "Content-Type": (
                    "application/octet-stream"
                    if isinstance(data, bytes)
                    else "application/json"
                ),
                **(headers or {}),
            },
        )
        with urlopen(req, timeout=5) as r:
            return json.load(r)

    def _loop(self):
        while not self.closed.is_set():
            active = False
            try:
                with self.lock:
                    meta = dict(self.meta)
                    pending = self.pending
                    self.pending = None
                    history_pending = self.history_pending
                    self.history_pending = None
                if history_pending:
                    try:
                        self._request(f"/producer/{self.id}/history", history_pending[0], history_pending[1])
                    except HTTPError as error:
                        if error.code != 409:
                            raise
                if pending:
                    try:
                        self._request(
                            f"/producer/{self.id}/snapshot", pending[0], pending[1]
                        )
                    except HTTPError as e:
                        if e.code != 409:
                            raise  # detached/expired viewers may discard a capture
                        with self.lock:
                            self.captured = 0
                response = self._request(f"/producer/{self.id}/status", meta)
                with self.lock:
                    if response["capture"]:
                        self.capture_target = response["captureSequence"]
                        self.static_revision = response["staticRevision"]
                    else:
                        self.capture_target = 0
                    request = response.get("historyRequest")
                    if request and request["id"] != self.history_seen:
                        self.history_request = request
                        self.history_seen = request["id"]
                self.pausing.set() if response.get("pause") else self.pausing.clear()
                active = response.get("attached", False) or bool(response.get("historyRequest"))
                if response["stop"]:
                    self.stopping.set()
                self.last_error = ""
            except (OSError, ValueError, KeyError) as e:
                self.last_error = str(e)
                with self.lock:
                    self.captured = (
                        0  # retry the next safe boundary after transport failure
                    )
            self.closed.wait(0.02 if active else self.interval)

    def update(self, **metadata):
        with self.lock:
            self.meta.update(metadata)

    @property
    def wants_snapshot(self):
        with self.lock:
            return self.capture_target > self.captured and self.pending is None

    def snapshot(self, arrays, *, step, time_value, domain=None):
        """Call only at a safe completed-step boundary. One pending capture maximum."""
        with self.lock:
            if self.capture_target <= self.captured or self.pending is not None:
                return False
            self.captured = self.capture_target
            generation = self.capture_target
            expected = self.static_revision
        raw = {
            name: numpy_array(value)
            for name, value in arrays.items()
            if value is not None
        }
        required = {
            "positions",
            "UIDs",
            "kinds",
            "masses",
            "densities",
            "supports",
            "velocities",
        }
        if not required <= raw.keys():
            raise ValueError(
                "Live snapshots require positions, stable IDs, kinds, masses, density, supports and velocity."
            )
        p = raw["positions"]
        n, dim = p.shape
        if dim not in (2, 3) or not n or n > 600000:
            raise ValueError("Live snapshots support up to 600,000 2D/3D particles.")
        for name, a in raw.items():
            if a.shape[0] != n or a.ndim not in (1, 2) or not np.isfinite(a).all():
                raise ValueError(f"Invalid live field {name}.")
        static = {k: raw.pop(k) for k in ("UIDs", "kinds", "masses")}
        digest = hashlib.sha256()
        for k, a in static.items():
            digest.update(k.encode())
            digest.update(str((a.dtype.str, a.shape)).encode())
            digest.update(a.tobytes())
        revision = digest.hexdigest()
        statics = (
            encode_frame(static, index=step, time=time_value)
            if expected != revision
            else b""
        )
        dynamics = encode_frame(raw, index=step, time=time_value)
        fields = [
            dict(name=k, components=a.shape[1] if a.ndim == 2 else 1, dtype=a.dtype.str)
            for k, a in {**static, **raw}.items()
        ]
        metadata = dict(
            name=self.name,
            dimension=dim,
            fields=fields,
            bounds=[p.min(axis=0).tolist(), p.max(axis=0).tolist()],
            identity="UIDs",
            domain=domain,
            internalEnergyAvailable="internalEnergies" in raw,
            step=step,
            time=time_value,
        )
        packet = struct.pack("<II", len(statics), len(dynamics)) + statics + dynamics
        with self.lock:
            self.pending = (
                packet,
                {
                    "X-Capture-Generation": str(generation),
                    "X-Static-Revision": revision,
                    "X-Snapshot-Metadata": json.dumps(
                        metadata, separators=(",", ":"), allow_nan=False
                    ),
                },
            )
        return True

    def recording(self, ctx):
        """Advertise existing exports, never enable storage implicitly."""
        if not ctx.spec.store or not ctx.exportPath:
            return
        if not getattr(self, "_recording", None):
            from pathlib import Path
            mode = ctx.spec.storeMode
            path = Path(ctx.exportPath) / ("trajectory.h5" if mode == "trajectory" else "trajectory")
            self._recording = dict(path=str(path.resolve()), mode=mode, name=self.name,
                domain={name: numpy_array(getattr(ctx.config.domain, name)).tolist()
                        for name in ("min", "max", "periodic")})
            self.update(recording=self._recording)

    def _history(self, ctx):
        with self.lock:
            request, self.history_request = self.history_request, None
        if not request:
            return
        try:
            from .recordings import read_recording
            writer = ctx.scratch.get("trajectoryFile")
            if writer is not None and writer.id.valid:
                writer.flush()
            if not getattr(self, "_recording", None):
                raise ValueError("Trajectory export is disabled.")
            body, kind = read_recording(self._recording, request["operation"], request["index"], request["field"])
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            body, kind = json.dumps({"error": str(error)[:500]}).encode(), "application/json"
        with self.lock:
            self.history_pending = (body, {"Content-Type": kind, "X-History-Request": request["id"]})

    def post_step(self, ctx, state, step):
        self.recording(ctx)
        while True:
            if self.stopping.is_set() or self.closed.is_set():
                raise SimulationStopped("Stopped from the companion.")
            paused = self.pausing.is_set()
            now = time.monotonic()
            if now - getattr(self, "_last_meta", 0) > 0.5 or getattr(self, "_paused", None) != paused:
                self._last_meta = now
                self._paused = paused
                self.update(
                    step=int(step), time=float(state.t), dt=float(ctx.config.dt),
                    particles=int(state.state.positions.shape[0]),
                    dimension=int(state.state.positions.shape[1]),
                    scheme=str(ctx.scheme).split(".")[-1],
                    status="paused" if paused else "running",
                )
            self._history(ctx)
            self._capture(ctx, state, step)
            if not paused:
                return
            # Status, stop, recording reads and live captures remain serviced
            # while the integrator is held at this completed-step boundary.
            self.closed.wait(0.02)

    def _capture(self, ctx, state, step):
        if not self.wants_snapshot:
            return
        s = state.state
        arrays = {
            name: getattr(s, name, None)
            for name in (
                "positions",
                "UIDs",
                "kinds",
                "masses",
                "supports",
                "densities",
                "velocities",
                "pressures",
                "internalEnergies",
            )
        }
        domain = {
            name: numpy_array(getattr(ctx.config.domain, name)).tolist()
            for name in ("min", "max", "periodic")
        }
        try:
            self.snapshot(
                arrays, step=int(step), time_value=float(state.t), domain=domain
            )
        except (ValueError, TypeError, IndexError) as error:
            # Viewing is optional: an unsupported capture must not kill a valid solver run.
            self.update(message=("Live capture unavailable: " + str(error))[:500])

    def close(self, status="completed", message=""):
        self.closed.set()
        self.thread.join(timeout=6)
        with self.lock:
            pending, self.pending = self.pending, None
            meta = {**self.meta, "status": status, "message": str(message)[:500]}
        try:
            if pending:
                self._request(f"/producer/{self.id}/snapshot", pending[0], pending[1])
        except (OSError, ValueError):
            pass
        try:
            self._request(f"/producer/{self.id}/status", meta)
        except (OSError, ValueError):
            pass

    def __enter__(self):
        return self

    def __exit__(self, kind, error, tb):
        self.close("failed" if kind else "completed", str(error or ""))


def run_live(case, *, name=None, runtime=None, **overrides):
    """Wrap an existing Case's postStep without changing simulator source code."""
    from dataclasses import replace
    from warpSPH.runner import run

    publisher = SimulationPublisher(name or case.name, runtime=runtime)
    old = case.postStep

    def post(ctx, state, step):
        if old:
            old(ctx, state, step)
        publisher.post_step(ctx, state, step)

    try:
        result = run(replace(case, postStep=post), **overrides)
        publisher.recording(result.ctx)
        publisher.update(
            step=result.nSteps,
            time=float(result.state.t),
            dt=float(result.ctx.config.dt),
            particles=int(result.state.state.positions.shape[0]),
        )
        publisher.close(
            "failed" if result.diverged or result.stopReason else "completed",
            result.stopReason or "",
        )
        return result
    except SimulationStopped:
        publisher.close("stopped")
        return None
    except BaseException as e:
        publisher.close("failed", str(e))
        raise
