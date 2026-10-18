"""Optional simulation-side resident adapter. No rendering and no Warp import."""

from __future__ import annotations
import json
import copy
import os
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import numpy as np
from .daemon import ensure_daemon, descriptor, runtime_dir
from .telemetry import StepTiming, ResourceSampler
from .protocol import DEFAULT_SNAPSHOT_BYTES
from .captures import Capture, owned_arrays, encode_capture


class SimulationStopped(Exception):
    pass


def numpy_array(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value)


class SimulationPublisher:
    def __init__(self, name, *, runtime=None, autostart=True, interval=0.5, video=None):
        self.name = name
        self.runtime = runtime_dir(runtime)
        self.started_at = time.time()
        self.info = ensure_daemon(runtime) if autostart else descriptor(runtime)
        self.interval = interval
        self.max_snapshot_bytes = self.info.get("maxSnapshotBytes", DEFAULT_SNAPSHOT_BYTES)
        self._capture_retry_at = 0.0
        self._transport_epoch = 0
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
        self._queued_capture = None
        self._copy_busy = self._transfer_busy = False
        self._capture_stats = {}
        self.configuration = self.configuration_pending = None
        self.video = None
        self.capture_interval = 0.5
        self._next_capture_at = 0.0
        self.transfer_event = threading.Event()
        self._last_published = None
        self.timing = StepTiming()
        self.resources = ResourceSampler()
        self.meta = {
            "status": "starting",
            "step": 0,
            "particles": 0,
            "time": 0.0,
            "dt": 0.0,
        }
        body = {"name": name, "pid": os.getpid(), "capabilities":["synchronizedVideo"]}
        if video is not None:
            from .catalogue import validate_video
            body['videoCapture']=validate_video(video)
        if os.environ.get("WARPSPH_REMOTE_RUN"):
            body["id"] = os.environ["WARPSPH_REMOTE_RUN"]
        registration = self._request("/producer/runs", body)
        self.video = registration.get("video")
        if registration.get("pause"):
            self.pausing.set()
        self.id = registration["id"]
        if video is not None and not self.video:
            message='Update the companion daemon to capture video from the initial state.'
            self._request(f'/producer/{self.id}/status',dict(status='failed',message=message))
            raise ValueError(message)
        self.started_at = registration.get("startedAt", self.started_at)
        self.telemetry_supported = "telemetry" in registration.get("features", [])
        self.capture_metrics_supported = "bufferedCapture" in registration.get("features", [])
        self.configuration_supported = "configurationInspection" in registration.get("features", [])
        self.thread = threading.Thread(
            target=self._loop, name="warpsph-companion-publisher", daemon=True
        )
        self.transfer_thread = threading.Thread(target=self._transfer_loop,
            name="warpsph-companion-transfer", daemon=True)
        self.transfer_thread.start()
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
        with urlopen(req, timeout=max(30, len(data)/2**20) if isinstance(data,bytes) else 5) as r:
            return json.load(r)

    def _recover(self):
        """Rejoin an explicitly restarted daemon; never respawn one on failure."""
        old_info = self.info
        try:
            self.info = descriptor(self.runtime)
            registration = self._request("/producer/runs", dict(
                id=self.id, name=self.name, pid=os.getpid(), reconnect=True,
                startedAt=self.started_at, paused=self.pausing.is_set(),
                managed=os.environ.get("WARPSPH_REMOTE_RUN") == self.id, video=self.video, capabilities=["synchronizedVideo"]))
            if registration["id"] != self.id:
                raise ValueError("Companion did not preserve the recovered run identity.")
            self.telemetry_supported = "telemetry" in registration.get("features", [])
            self.capture_metrics_supported = "bufferedCapture" in registration.get("features", [])
            self.configuration_supported = "configurationInspection" in registration.get("features", [])
            with self.lock:
                self._transport_epoch += 1
                self.pending = self._queued_capture = None
                self.configuration_pending = self.configuration
                self._next_capture_at = 0.0
                self.capture_target = self.captured = 0
                self.static_revision = self._last_published = None
                self.history_request = self.history_pending = self.history_seen = None
            return True
        except (OSError, ValueError, KeyError):
            self.info = old_info
            return False

    def _loop(self):
        while not self.closed.is_set():
            active = False
            try:
                resources = self.resources.sample() if self.telemetry_supported else None
                with self.lock:
                    meta = dict(self.meta)
                    if resources is not None:
                        meta["resources"] = resources
                response = self._request(f"/producer/{self.id}/status", meta)
                with self.lock:
                    self.max_snapshot_bytes = response.get("maxSnapshotBytes", self.max_snapshot_bytes)
                    self.capture_interval = response.get("captureInterval", self.capture_interval)
                    self.video = response.get("video")
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
                # Credentials and run registry belong to the daemon process, while
                # pause state belongs to this integrator's safe boundary.
                try:
                    info = descriptor(self.runtime)
                    changed = (info.get("producerToken"), info.get("endpoint")) != (self.info.get("producerToken"), self.info.get("endpoint"))
                except (OSError, ValueError, KeyError):
                    changed = False
                if changed or isinstance(e, HTTPError) and e.code in (400, 401, 404):
                    self._recover()
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
            return (self.capture_target > self.captured and self.pending is None
                    and self._queued_capture is None and not self._copy_busy and not self._transfer_busy
                    and time.monotonic() >= max(self._capture_retry_at, self._next_capture_at))

    def snapshot(self, arrays, *, step, time_value, domain=None, details=None):
        """Own one CPU copy at a safe boundary; encode/send asynchronously.

        True means queued, not delivered. Validation/encoding failures are reported
        in status without stopping the integrator. No queue of historical states.
        """
        with self.lock:
            if (self.capture_target <= self.captured or self.pending is not None
                    or self._queued_capture is not None or self._copy_busy or self._transfer_busy
                    or time.monotonic() < max(self._capture_retry_at, self._next_capture_at)):
                return False
            generation, epoch, expected = self.capture_target, self._transport_epoch, self.static_revision
            self._copy_busy = True
        started = time.perf_counter()
        try:
            raw = owned_arrays(arrays, self.max_snapshot_bytes)
            capture = Capture(raw, int(step), float(time_value), copy.deepcopy(domain), generation,
                epoch, expected, (time.perf_counter()-started)*1000, sum(a.nbytes for a in raw.values()), copy.deepcopy(details))
            with self.lock:
                if epoch != self._transport_epoch or generation != self.capture_target:
                    return False
                self.captured = generation
                self._queued_capture = capture
                self._next_capture_at = time.monotonic() + self.capture_interval
                self._capture_stats.update(captureMs=capture.copy_ms, captureBytes=capture.cpu_bytes, captureStep=capture.step)
                if self.capture_metrics_supported:
                    self.meta['performance'] = {**self.meta.get('performance',{}), **self._capture_stats}
            self.transfer_event.set()
            return True
        finally:
            with self.lock:
                self._copy_busy = False

    def _capture_failure(self, error):
        with self.lock:
            self.captured = 0
            self._capture_retry_at = time.monotonic() + max(0.5, self.interval)
            self.meta['message'] = ('Live capture unavailable: '+str(error))[:500]

    def _transfer_loop(self):
        while True:
            self.transfer_event.wait(0.05)
            self.transfer_event.clear()
            with self.lock:
                capture, self._queued_capture = self._queued_capture, None
                history, self.history_pending = self.history_pending, None
                configuration, self.configuration_pending = self.configuration_pending, None
                if capture is None and history is None and configuration is None:
                    if self.closed.is_set(): return
                    continue
                self._transfer_busy = True
            try:
                if configuration:
                    self._request(f"/producer/{self.id}/configuration", configuration)
                if history:
                    try:
                        self._request(f'/producer/{self.id}/history', history[0], history[1])
                    except HTTPError as error:
                        if error.code != 409: raise
                if capture:
                    started = time.perf_counter()
                    packet = encode_capture(capture, self.name, self.max_snapshot_bytes)
                    encoded_ms = (time.perf_counter()-started)*1000
                    with self.lock:
                        if capture.epoch != self._transport_epoch or capture.generation != self.capture_target:
                            continue
                        self.pending = packet
                    started = time.perf_counter()
                    self._request(f'/producer/{self.id}/snapshot', packet[0], packet[1])
                    with self.lock:
                        if capture.epoch == self._transport_epoch:
                            self._last_published = packet[2]
                            self._capture_stats.update(encodeMs=encoded_ms, publishMs=(time.perf_counter()-started)*1000)
                            if self.capture_metrics_supported:
                                self.meta['performance'] = {**self.meta.get('performance',{}), **self._capture_stats}
                            if self.meta.get('message','').startswith('Live capture unavailable:'):
                                self.meta['message'] = ''
            except (ValueError, TypeError, IndexError) as error:
                self._capture_failure(error)
            except OSError as error:
                self.last_error = str(error)
                with self.lock:
                    if configuration and not self.closed.is_set():
                        self.configuration_pending = configuration
                    self.captured = 0
                    self._capture_retry_at = time.monotonic() + max(0.5, self.interval)
            finally:
                with self.lock:
                    self.pending = None
                    self._transfer_busy = False

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
        if self.configuration_supported and self.configuration is None:
            # Snapshot fixed setup once; adaptive dt remains a live status field.
            try:
                if not hasattr(ctx, "case") or not hasattr(ctx.spec, "toDict"):
                    raise AttributeError("No resolved case configuration")
                from warpSPH.configurations import configurationToDict
                configuration = dict(schemaVersion=1, case=ctx.case.name,
                    requested=getattr(ctx.spec,'configuration',None), spec=ctx.spec.toDict(),
                    simulationConfig=configurationToDict(ctx.config), solverConfig=ctx.exportFunction(ctx.schemeConfig))
                configuration = json.loads(json.dumps(configuration,allow_nan=False))
            except (ImportError,AttributeError,TypeError,ValueError):
                configuration = dict(case=self.name, solver=dict(scheme=str(ctx.scheme)),
                    simulation=dict(dt=float(ctx.config.dt)), note='Full resolved configuration was not supplied by this adapter.')
            with self.lock:
                self.configuration = self.configuration_pending = configuration
            self.transfer_event.set()
        pause_start = None
        while True:
            if self.stopping.is_set() or self.closed.is_set():
                raise SimulationStopped("Stopped from the companion.")
            video = self.video or {}
            video_wait = video.get('active') and (video.get('orphaned') or
                (float(state.t) >= video.get('nextTime',-1) and
                 (video.get('ackStep',-1) < int(step) or video.get('ackTime',-1) < float(state.t))))
            paused = self.pausing.is_set()
            held = paused or video_wait
            now = time.monotonic()
            if held and pause_start is None:
                pause_start = now
            if now - getattr(self, "_last_meta", 0) > 0.5 or getattr(self, "_paused", None) != paused:
                simulation_time = float(state.t)
                telemetry = {}
                if self.telemetry_supported:
                    timing = self.timing.observe(int(step), simulation_time, time.monotonic())
                    spec = ctx.spec
                    limit_steps = getattr(spec, "nSteps", None)
                    if limit_steps is not None:
                        timing["targetStep"] = max(0, int(limit_steps) + getattr(spec, "resumeStepOffset", 0) - 1)
                    elif getattr(spec, "tLimit", None) is not None:
                        timing["targetTime"] = float(spec.tLimit)
                    with self.lock:
                        telemetry["performance"] = {**timing, **(self._capture_stats if self.capture_metrics_supported else {})}
                self._last_meta = now
                self._paused = paused
                self.update(
                    step=int(step), time=simulation_time, dt=float(ctx.config.dt),
                    particles=int(state.state.positions.shape[0]),
                    dimension=int(state.state.positions.shape[1]),
                    scheme=str(ctx.scheme).split(".")[-1],
                    status="paused" if paused else "running",
                    **telemetry,
                )
            self._history(ctx)
            self._capture(ctx, state, step)
            if not held:
                if pause_start is not None:
                    self.timing.exclude_pause(time.monotonic() - pause_start)
                return
            # Status, stop, recording reads and live captures remain serviced
            # while the integrator is held at this completed-step boundary.
            self.closed.wait(0.02)

    def _capture(self, ctx, state, step):
        video=self.video or {}
        if video.get('active') and float(state.t) < video.get('nextTime',-1) and not self.meta.get('videoFinishing'):
            return
        if not self.wants_snapshot:
            return
        with self.lock:
            if self._last_published == (int(step), float(state.t), self.static_revision):
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
        try:
            domain = {
                name: numpy_array(getattr(ctx.config.domain, name)).tolist()
                for name in ("min", "max", "periodic")
            }
            self.snapshot(
                arrays, step=int(step), time_value=float(state.t), domain=domain,
                details=dict(dt=float(ctx.config.dt), scheme=str(ctx.scheme).split(".")[-1],
                    kernel=str(getattr(ctx.config,'kernel','')).split('.')[-1],
                    integrator=str(getattr(ctx.config,'integrationScheme','')).split('.')[-1],
                    **({'videoArmed':dict(fps=video.get('fps',30),interval=video['interval'])} if video.get('armed') else {}))
            )
        except (ValueError, TypeError, IndexError) as error:
            # Viewing is optional: an unsupported capture must not kill a valid solver run.
            with self.lock:
                self._capture_retry_at = time.monotonic() + max(0.5, self.interval)
                self.meta["message"] = ("Live capture unavailable: " + str(error))[:500]

    def initial_state(self, ctx, state):
        """The extraData hook sees initialized physics before the first step."""
        if getattr(self,'_initial_seen',False): return
        self._initial_seen=True
        if (self.video or {}).get('active') or self.pausing.is_set():
            self.post_step(ctx,state,0)

    def bind_case(self, case):
        from dataclasses import replace
        old_post,old_extra=case.postStep,case.extraData
        def post(ctx,state,step):
            if old_post: old_post(ctx,state,step)
            self.post_step(ctx,state,step)
        def extra(ctx,state):
            data=old_extra(ctx,state) if old_extra else {}
            self.initial_state(ctx,state)
            return data
        return replace(case,postStep=post,extraData=extra)

    def finish(self, ctx, state, step):
        """Deliver the last rendered video frame before publishing completion."""
        if not (self.video or {}).get('active'):
            return
        self.update(videoFinishing=True, time=float(state.t), step=int(step))
        # Let the control worker request a final capture even when it falls
        # between regular simulation-time frame boundaries.
        while (self.video or {}).get('active') and (self.video or {}).get('ackTime',-1) < float(state.t):
            self.post_step(ctx, state, step)
            self.closed.wait(.02)
        self.update(videoFinishing=False)

    def close(self, status="completed", message=""):
        self.closed.set()
        self.transfer_event.set()
        self.thread.join(timeout=6)
        self.transfer_thread.join(timeout=6)
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


def run_live(case, *, name=None, runtime=None, video=None, **overrides):
    """Wrap an existing Case's postStep without changing simulator source code."""
    from warpSPH.runner import run

    publisher = SimulationPublisher(name or case.name, runtime=runtime, video=video)
    try:
        result = run(publisher.bind_case(case), **overrides)
        publisher.recording(result.ctx)
        publisher.finish(result.ctx, result.state, result.nSteps)
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
