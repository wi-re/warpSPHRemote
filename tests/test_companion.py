"""Companion boundaries and the one-buffer producer/viewer handshake."""

from functools import partial
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
import pytest

from warpsph_remote.catalogue import CATALOGUE, validate_launch
from warpsph_remote.daemon import Conflict, Handler, Manager, descriptor, runtime_dir
from warpsph_remote.launcher import handoff, install_xdg
from warpsph_remote.publisher import SimulationPublisher
from warpsph_remote.protocol import encode_frame


@pytest.fixture(autouse=True)
def private_pairing_state(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_STATE_HOME', str(tmp_path / 'pairing-state'))


@pytest.fixture
def api(tmp_path):
    m = Manager(tmp_path / "private")
    m.catalogue = CATALOGUE
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, manager=m))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"

    def call(path, data=None, token=None, headers=None, method=None):
        raw = (
            data
            if isinstance(data, bytes)
            else json.dumps(data).encode() if data is not None else None
        )
        h = {
            "Authorization": "Bearer " + (token or m.token),
            "Content-Type": "application/json",
            **(headers or {}),
        }
        return urlopen(
            Request(endpoint + path, data=raw, headers=h, method=method), timeout=3
        )

    yield m, call, endpoint
    m.shutdown()
    server.shutdown()
    server.server_close()
    thread.join()


def arrays():
    return dict(
        positions=np.array([[0.0, 0.0], [0.5, 0.5]], dtype=np.float32),
        UIDs=np.array([2**54 + 1, 9], dtype=np.int64),
        kinds=np.zeros(2, dtype=np.int32),
        masses=np.ones(2),
        densities=np.ones(2),
        supports=np.ones(2) * 0.2,
        velocities=np.ones((2, 2)),
    )


def test_authentication_and_browser_producer_separation(api):
    m, call, _ = api
    for path, token in [
        ("/v1/session", "bad"),
        ("/v1/runs", m.producer_token),
        ("/producer/runs", m.token),
    ]:
        with pytest.raises(HTTPError) as e:
            call(path, {"name": "test"} if "producer" in path else None, token)
        assert e.value.code == 401
    session=json.load(call("/v1/session"))
    assert session["loopbackOnly"]
    assert set(session["features"]) == {"pause", "recordedHistory", "configuration", "viewerTakeover", "producerRecovery", "streaming", "configurationInspection", "synchronizedVideo", "videoFromStart", "runLibrary", "diagnosticRecording", "oneDimensional", "captureDiagnostics", "stepVideo", "recordingEstimates"}
    assert json.load(call("/producer/runs", {"name": "test"}, m.producer_token))["id"]


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://untrusted.example"},
        {"Host": "evil.example:8766"},
        {"Host": "127.0.0.1:bad"},
        {"Host": "127.0.0.1:1"},
        {"Host": "user@localhost:8766"},
    ],
)
def test_origin_and_host_allowlists(api, headers):
    _, call, _ = api
    with pytest.raises(HTTPError) as e:
        call("/v1/session", headers=headers)
    assert e.value.code == 403


def test_cors_preflight_and_no_store(api):
    _, call, _ = api
    with call(
        "/v1/session", headers={"Origin": "https://fluids.dev"}, method="OPTIONS"
    ) as r:
        assert r.status == 204
        assert r.headers["Access-Control-Allow-Origin"] == "https://fluids.dev"
        assert r.headers["Access-Control-Allow-Private-Network"] == "true"
    with call("/v1/session") as r:
        assert r.headers["Cache-Control"] == "no-store"


def test_metadata_only_until_attached_and_single_viewer(api):
    m, _, _ = api
    key = m.register({"name": "existing simulation", "pid": 123})
    response = m.status(
        key, dict(step=100, time=2.0, dt=0.001, particles=16384, status="running")
    )
    assert not response["capture"] and m.runs[key]["snapshot"] is None
    m.attach(key, "viewer-aaaaaaaaaaaa")
    assert m.status(key, {})["capture"]
    with pytest.raises(Conflict):
        m.attach(key, "viewer-bbbbbbbbbbbb")
    assert m.public(m.runs[key])["particles"] == 16384


def test_handshake_static_reuse_exact_ids_and_detach_reattach(api, tmp_path):
    m, call, endpoint = api
    info = dict(endpoint=endpoint, producerToken=m.producer_token, token=m.token)
    (m.root / "daemon.json").write_text(json.dumps(info))
    (m.root / "daemon.json").chmod(0o600)
    publisher = SimulationPublisher(
        "fixture", runtime=m.root, autostart=False, interval=0.01
    )
    viewer = "viewer-aaaaaaaaaaaa"
    h = {"X-Viewer-Id": viewer}
    try:
        assert not publisher.wants_snapshot
        m.attach(publisher.id, viewer)
        until = time.monotonic() + 2
        while not publisher.wants_snapshot and time.monotonic() < until:
            time.sleep(0.01)
        assert publisher.snapshot(arrays(), step=10, time_value=0.1)
        until = time.monotonic() + 2
        while m.runs[publisher.id]["snapshot"] is None and time.monotonic() < until:
            time.sleep(0.01)
        run = m.runs[publisher.id]
        static = run["static"]
        sequence = run["sequence"]
        with call(f"/v1/runs/{publisher.id}/snapshot", headers=h) as r:
            assert r.read()[:4] == b"WPR1"
            assert int(r.headers["X-Snapshot-Sequence"]) == sequence
        # No full state is requested while the previous one awaits acknowledgement.
        assert not m.status(publisher.id, {})["capture"]
        assert not publisher.snapshot(arrays(), step=11, time_value=0.11)
        call(f"/v1/runs/{publisher.id}/ack", {"sequence": sequence}, headers=h).close()
        with pytest.raises(HTTPError):
            call(f"/v1/runs/{publisher.id}/ack", {"sequence": sequence}, headers=h)
        until = time.monotonic() + 2
        while not publisher.wants_snapshot and time.monotonic() < until:
            time.sleep(0.01)
        publisher.snapshot(arrays(), step=12, time_value=0.12)
        until = time.monotonic() + 2
        while run["snapshot"] is None and time.monotonic() < until:
            time.sleep(0.01)
        assert run["static"] is static  # zero new static packet / resident allocation
        size = struct.unpack("<I", static[4:8])[0]
        header = json.loads(static[8 : 8 + size])
        base = 8 + (size + 7) // 8 * 8
        uid = header["arrays"]["UIDs"]
        assert (
            np.frombuffer(static, dtype="<i8", offset=base + uid["offset"], count=2)[0]
            == 2**54 + 1
        )
        old_generation = run["captureGeneration"]
        call(f"/v1/runs/{publisher.id}/detach", {}, headers=h).close()
        assert run["snapshot"] is None and run["static"] is None
        m.attach(publisher.id, viewer)
        assert run["captureGeneration"] > old_generation
        until = time.monotonic() + 2
        while not publisher.wants_snapshot and time.monotonic() < until:
            time.sleep(0.01)
        assert publisher.snapshot(arrays(), step=14, time_value=0.14)
        until = time.monotonic() + 2
        while run["snapshot"] is None and time.monotonic() < until:
            time.sleep(0.01)
        assert run["snapshot"] is not None and run["static"] is not None
    finally:
        publisher.close()


def test_expired_viewer_frees_particle_buffers(api):
    m, _, _ = api
    key = m.register({"name": "test"})
    m.attach(key, "viewer-aaaaaaaaaaaa")
    m.runs[key].update(
        leaseAt=time.monotonic() - 21, snapshot=b"large", static=b"large"
    )
    assert not m.status(key, {})["capture"]
    assert m.runs[key]["snapshot"] is None and m.runs[key]["static"] is None


def test_stale_capture_generation_cannot_cross_leases(api):
    m, _, _ = api
    key = m.register({"name": "test"})
    m.attach(key, "viewer-aaaaaaaaaaaa")
    generation = m.runs[key]["captureGeneration"]
    static = encode_frame({"UIDs": np.array([1])}, index=0, time=0.0)
    dynamic = encode_frame({"positions": np.zeros((1, 2))}, index=0, time=0.0)
    packet = struct.pack("<II", len(static), len(dynamic)) + static + dynamic
    m.runs[key]["lease"] = None
    m.attach(key, "viewer-bbbbbbbbbbbb")
    with pytest.raises(Conflict):
        m.upload(key, packet, {}, "r", generation)


@pytest.mark.parametrize(
    "spec",
    [
        {"preset": "../../os"},
        {"preset": "gresho", "command": "rm"},
        {"preset": "gresho", "scheme": "PESPH"},
        {"preset": "rt", "scheme": "MFM"},
        {"preset": "gresho", "nx": True},
        {"preset": "gresho", "nx": 513},
        {"preset": "gresho", "duration": float("nan")},
        {"preset": "gresho", "steps": -1},
    ],
)
def test_browser_launch_is_bounded_and_allowlisted(spec):
    with pytest.raises(ValueError):
        validate_launch(spec)


def test_all_catalogue_defaults_validate():
    for case in CATALOGUE:
        assert validate_launch({"preset": case["id"]})["nx"] == case["nx"]


def test_private_runtime_and_descriptor(tmp_path):
    p = tmp_path / "owned"
    runtime_dir(p)
    assert stat.S_IMODE(p.stat().st_mode) == 0o700
    f = p / "daemon.json"
    f.write_text("{}")
    f.chmod(0o644)
    with pytest.raises(ValueError):
        descriptor(p)
    f.chmod(0o600)
    assert descriptor(p) == {}
    p.chmod(0o755)
    with pytest.raises(ValueError):
        runtime_dir(p)


def test_desktop_handler_and_secret_fragment(tmp_path):
    entry = install_xdg(tmp_path, register=False).read_text()
    assert "x-scheme-handler/warpsph" in entry and " %u" in entry
    url = handoff(dict(endpoint="http://127.0.0.1:8766", token="secret"))
    from urllib.parse import urlsplit, parse_qs

    assert not urlsplit(url).query
    assert parse_qs(urlsplit(url).fragment)["pair"] == ["secret"]


def test_concurrent_simulation_starts_reuse_one_loopback_daemon(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    from concurrent.futures import ThreadPoolExecutor
    from warpsph_remote.daemon import ensure_daemon
    import signal

    root = tmp_path / "singleton"
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: ensure_daemon(root, port=0), range(3)))
        assert len({r["pid"] for r in results}) == 1
        assert len({r["token"] for r in results}) == 1
        assert results[0]["endpoint"].startswith("http://127.0.0.1:")
        assert len(results[0]["token"]) >= 40
        assert stat.S_IMODE((root / "daemon.json").stat().st_mode) == 0o600
        assert "Pairing token:" not in (root / "daemon.log").read_text()
    finally:
        if (root / "daemon.json").exists():
            os.kill(descriptor(root)["pid"], signal.SIGTERM)
            until = time.monotonic() + 3
            while (root / "daemon.json").exists() and time.monotonic() < until:
                time.sleep(0.05)


def test_malformed_snapshot_is_rejected_before_replacing_current(api):
    m, _, _ = api
    key = m.register({"name": "test"})
    m.attach(key, "viewer-aaaaaaaaaaaa")
    with pytest.raises(ValueError):
        m.upload(
            key,
            struct.pack("<II", 4, 4) + b"WPR1WPR1",
            {},
            "r",
            m.runs[key]["captureGeneration"],
        )
    assert m.runs[key]["snapshot"] is None and m.runs[key]["capture"]


def test_managed_launcher_uses_fixed_worker_and_stops_only_owned_process(
    api, monkeypatch
):
    import signal
    import warpsph_remote.daemon as module

    m, _, _ = api
    commands = []
    signals = []

    class Process:
        pid = 999999

        def poll(self):
            return None

    class DeferredThread:
        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(
        module.subprocess,
        "Popen",
        lambda command, **kwargs: commands.append((command, kwargs)) or Process(),
    )
    monkeypatch.setattr(module.threading, "Thread", DeferredThread)
    monkeypatch.setattr(
        module.os, "killpg", lambda pid, sig: signals.append((pid, sig))
    )
    run = m.launch({"preset": "gresho", "nx": 32})
    command, options = commands[0]
    assert command[0] == m.python
    assert Path(command[1]).name == "simulation_worker.py"
    assert options.get("shell", False) is False and options["start_new_session"] is True
    assert json.loads(Path(command[2]).read_text())["nx"] == 32
    with pytest.raises(Conflict):
        m.launch({"preset": "tgv"})
    m.stop(run["id"])
    assert signals == [(999999, signal.SIGTERM)]
    external = m.register({"name": "external", "pid": 999998})
    m.stop(external)
    assert len(signals) == 1 and m.status(external, {})["stop"]
    # Teardown does not operate on the fake PID after monkeypatch restoration.
    m.runs[run["id"]].pop("process")


@pytest.mark.parametrize(
    "path,value",
    [("/producer/runs", 5), ("/v1/runs", []), ("/producer/runs", {"name": ""})],
)
def test_invalid_control_objects_return_client_errors(api, path, value):
    m, call, _ = api
    with pytest.raises(HTTPError) as e:
        call(path, value, m.producer_token if path.startswith("/producer") else m.token)
    assert e.value.code == 400


def test_failed_bind_releases_singleton_lock(api):
    import fcntl
    from urllib.parse import urlsplit
    from warpsph_remote.daemon import serve

    m, _, endpoint = api
    with pytest.raises(OSError):
        serve(m.root, port=urlsplit(endpoint).port, incidental=True)
    fd = os.open(m.root / "daemon.lock", os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)


def test_worker_entry_bootstraps_only_its_package_in_an_isolated_python(tmp_path):
    import subprocess, sys
    import warpsph_remote.simulation_worker as worker

    spec = tmp_path / "invalid.json"
    spec.write_text('{"preset":"unknown"}')
    result = subprocess.run(
        [sys.executable, "-I", worker.__file__, str(spec)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert "Unknown simulation preset." in result.stderr
    assert "attempted relative import" not in result.stderr


def test_recording_is_explicit_and_interval_is_bounded():
    assert validate_launch({"preset": "gresho"})["record"] is False
    assert validate_launch({"preset": "gresho", "record": True, "exportInterval": .1})["record"]
    for value in [0, -1, float("nan"), True, "0.1"]:
        with pytest.raises(ValueError):
            validate_launch({"preset": "gresho", "exportInterval": value})
    with pytest.raises(ValueError):
        validate_launch({"preset": "gresho", "record": "yes"})


def wait_for(predicate, seconds=3):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Companion state did not arrive before the deadline")
        time.sleep(.01)


def test_paused_producer_serves_live_and_existing_history_then_stops(api, tmp_path):
    import h5py
    from types import SimpleNamespace as NS
    from warpsph_remote.publisher import SimulationStopped
    from warpsph_remote.protocol import validate_packet

    m, call, endpoint = api
    (m.root / "daemon.json").write_text(json.dumps(dict(endpoint=endpoint, producerToken=m.producer_token)))
    (m.root / "daemon.json").chmod(0o600)
    p = SimulationPublisher("recorded fixture", runtime=m.root, autostart=False, interval=.01)
    file = h5py.File(tmp_path / "trajectory.h5", "w")
    values = arrays()
    for name in ("UIDs", "kinds", "masses", "supports"):
        file["combined" + name[0].upper() + name[1:]] = values[name]
    for name in ("positions", "velocities", "densities"):
        file[f"{name}/frame_00000"] = values[name]
    file["times/frame_00000"] = [.1]
    ctx = NS(spec=NS(store=True, storeMode="trajectory"), exportPath=str(tmp_path),
             scratch={"trajectoryFile": file}, scheme="deltaSPH",
             config=NS(dt=.01, domain=NS(min=np.zeros(2), max=np.ones(2), periodic=np.ones(2,dtype=bool))))
    state = NS(t=.1, state=NS(**values))
    failures=[]
    def step_boundary():
        try:
            p.post_step(ctx, state, 10)
            failures.append("advanced while paused")
        except SimulationStopped:
            pass
    try:
        call(f"/v1/runs/{p.id}/pause", {}).close()
        wait_for(p.pausing.is_set)
        worker=threading.Thread(target=step_boundary)
        worker.start()
        wait_for(lambda: m.runs[p.id].get("status") == "paused")
        assert worker.is_alive()
        metadata=json.load(call(f"/v1/runs/{p.id}/history"))
        assert metadata["frames"] == 1 and metadata["times"] == [.1]
        packet=call(f"/v1/runs/{p.id}/history/frame?index=0&field=velocities").read()
        assert validate_packet(packet)["index"] == 0
        m.attach(p.id,"viewer-aaaaaaaaaaaa")
        wait_for(lambda: m.runs[p.id].get("snapshot") is not None)
        assert m.runs[p.id]["metadata"]["time"] == .1
        assert worker.is_alive() and m.runs[p.id]["time"] == .1
        # A paused producer holds the next request instead of recapturing the same state.
        sequence = m.runs[p.id]["sequence"]
        headers = {"X-Viewer-Id": "viewer-aaaaaaaaaaaa"}
        call(f"/v1/runs/{p.id}/ack", {"sequence": sequence}, headers=headers).close()
        wait_for(lambda: p.wants_snapshot)
        time.sleep(.15)
        assert m.runs[p.id]["sequence"] == sequence
        assert m.runs[p.id]["snapshot"] is None
        # Another lease still gets the current paused state, with fresh static data.
        call(f"/v1/runs/{p.id}/detach", {}, headers=headers).close()
        m.attach(p.id,"viewer-aaaaaaaaaaaa")
        wait_for(lambda: m.runs[p.id]["snapshot"] is not None)
        assert m.runs[p.id]["sequence"] > sequence

        call(f"/v1/runs/{p.id}/stop", {}).close()
        worker.join(3)
        assert not worker.is_alive() and not failures
        file.close()
        p.close("stopped")
        # Terminal history no longer depends on a live producer thread.
        assert json.load(call(f"/v1/runs/{p.id}/history"))["frames"] == 1
        assert m.public(m.runs[p.id])["recording"]["enabled"]
        assert "path" not in m.public(m.runs[p.id])["recording"]
    finally:
        m.stop(p.id)
        p.stopping.set()
        file.close()
        p.close("stopped")


def test_resume_releases_step_boundary_and_history_timeout_expires(api):
    m, call, _ = api
    key=m.register({"name":"test"})
    m.pause(key,True)
    assert m.status(key,{"status":"paused"})["pause"]
    call(f"/v1/runs/{key}/resume",{}).close()
    assert not m.status(key,{})["pause"]
    with pytest.raises(Conflict,match="disabled"):
        m.history(key,"metadata")
    m.status(key,{"recording":{"path":"/tmp/nonexistent-test-recording.h5","mode":"trajectory"}})
    with pytest.raises(Conflict,match="step boundary"):
        m.history(key,"metadata",timeout=.01)
    assert not m.runs[key].get("historyPending")
    with pytest.raises(Conflict,match="expired"):
        m.history_result(key,"old",b'{}',"application/json")


def test_existing_checkpoint_exports_are_history_without_copying_files(tmp_path):
    import h5py
    from warpsph_remote.recordings import read_recording
    from warpsph_remote.protocol import validate_packet
    directory=tmp_path/'trajectory';directory.mkdir()
    for name,t in [('initialState',0.),('state_0000',.1),('state_0002',.3)]:
        with h5py.File(directory/f'{name}.h5','w') as file:
            file.attrs['time']=t
            for field,value in arrays().items():file[f'state/{field}']=value
    before=set(directory.iterdir())
    recording=dict(path=str(directory),mode='states')
    body,kind=read_recording(recording)
    assert kind=='application/json' and json.loads(body)['times']==[0.,.1,.3]
    body,kind=read_recording(recording,'frame',2,'velocities')
    assert kind=='application/octet-stream' and validate_packet(body)['time']==.3
    assert set(directory.iterdir())==before
    with pytest.raises(ValueError,match='out of range'):
        read_recording(recording,'frame',3,'velocities')


def test_large_live_frame_is_bounded_by_bytes_not_particle_count(api):
    # Actual equal-mass triplePoint nx=256 particle count, above the old 600k cap.
    from warpsph_remote.protocol import validate_packet
    m, call, endpoint = api
    (m.root / "daemon.json").write_text(json.dumps(dict(endpoint=endpoint, producerToken=m.producer_token)))
    (m.root / "daemon.json").chmod(0o600)
    p = SimulationPublisher("triplePoint-sized fixture", runtime=m.root, autostart=False, interval=.01)
    n = 765418
    values = {"positions": np.zeros((n, 2), np.float32), "velocities": np.zeros((n, 2), np.float32),
              "UIDs": np.arange(n, dtype=np.int32), "kinds": np.zeros(n, np.int32),
              **{k: np.ones(n, np.float32) for k in ("masses", "supports", "densities", "pressures", "internalEnergies")}}
    try:
        m.attach(p.id, "viewer-aaaaaaaaaaaa")
        wait_for(lambda: p.wants_snapshot)
        assert p.snapshot(values, step=1, time_value=.002)
        wait_for(lambda: m.runs[p.id]["snapshot"] is not None)
        run = m.runs[p.id]
        assert validate_packet(run["snapshot"])["arrays"]["positions"]["shape"] == [n, 2]
        static = run["static"]
        assert validate_packet(static)["arrays"]["UIDs"]["shape"] == [n]
        # A delayed consumer never triggers another full capture until acknowledgement.
        assert not p.wants_snapshot
        headers = {"X-Viewer-Id": "viewer-aaaaaaaaaaaa"}
        call(f"/v1/runs/{p.id}/ack", {"sequence": run["sequence"]}, headers=headers).close()
        wait_for(lambda: p.wants_snapshot)
        assert p.snapshot(values, step=2, time_value=.004)
        wait_for(lambda: run["snapshot"] is not None)
        assert run["static"] is static
    finally:
        p.close()


def test_capture_failure_retries_and_clears_message_after_recovery(api):
    from types import SimpleNamespace as NS
    m, call, endpoint = api
    (m.root / "daemon.json").write_text(json.dumps(dict(endpoint=endpoint, producerToken=m.producer_token)))
    (m.root / "daemon.json").chmod(0o600)
    p = SimulationPublisher("retry fixture", runtime=m.root, autostart=False, interval=.01)
    values = arrays()
    state = NS(t=.1, state=NS(**values))
    ctx = NS(spec=NS(store=False), config=NS(dt=.01, domain=NS(min=np.zeros(2), max=np.ones(2), periodic=np.ones(2, dtype=bool))), scheme="CRKSPH")
    try:
        m.attach(p.id, "viewer-aaaaaaaaaaaa")
        wait_for(lambda: p.wants_snapshot)
        # Transient invalid optional field must not consume this capture request.
        state.state.pressures = np.full(2, np.nan)
        p.post_step(ctx, state, 1)
        assert not p.wants_snapshot  # retry is throttled, not attempted at every solver step
        wait_for(lambda: "Invalid live field pressures" in m.runs[p.id].get("message", ""))
        assert m.runs[p.id]["status"] == "running"
        state.state.pressures = np.ones(2)
        wait_for(lambda: p.wants_snapshot)
        p.post_step(ctx, state, 2)
        wait_for(lambda: m.runs[p.id]["snapshot"] is not None)
        wait_for(lambda: not m.runs[p.id].get("message"))
        assert m.runs[p.id]["metadata"]["step"] == 2
    finally:
        p.close()


def test_snapshot_memory_budget_is_negotiated_and_enforced(api):
    m, call, endpoint = api
    # A small budget makes both limits testable without allocating hundreds of MiB.
    m.max_snapshot_bytes = 4096
    assert json.load(call("/v1/session"))["maxSnapshotBytes"] == 4096
    (m.root / "daemon.json").write_text(json.dumps(dict(endpoint=endpoint, producerToken=m.producer_token)))
    (m.root / "daemon.json").chmod(0o600)
    p = SimulationPublisher("budget fixture", runtime=m.root, autostart=False, interval=.01)
    try:
        m.attach(p.id, "viewer-aaaaaaaaaaaa")
        wait_for(lambda: p.wants_snapshot)
        assert p.max_snapshot_bytes == 4096
        values = {k: np.repeat(a, 100, axis=0) for k,a in arrays().items()}
        with pytest.raises(ValueError, match="Increase --max-snapshot-mib"):
            p.snapshot(values, step=1, time_value=.1)
        assert p.wants_snapshot  # no pending or consumed capture on failure
        static = encode_frame({k:values[k] for k in ("UIDs", "kinds", "masses")}, index=1, time=.1)
        dynamic = encode_frame({k:v for k,v in values.items() if k not in ("UIDs", "kinds", "masses")}, index=1, time=.1)
        packet = struct.pack("<II", len(static), len(dynamic)) + static + dynamic
        with pytest.raises(ValueError, match="--max-snapshot-mib"):
            m.upload(p.id, packet, {}, "revision", m.runs[p.id]["captureGeneration"])
        # A larger daemon-selected budget is propagated to an already registered producer.
        m.max_snapshot_bytes = 32768
        wait_for(lambda: p.max_snapshot_bytes == 32768)
        assert p.snapshot(values, step=2, time_value=.2)
        wait_for(lambda: m.runs[p.id]["snapshot"] is not None)
    finally:
        p.close()


@pytest.mark.parametrize('budget', [0, -1, True, 2**32, 1.5])
def test_invalid_snapshot_budget_rejected_before_runtime_creation(tmp_path, budget):
    root = tmp_path / 'invalid-budget'
    with pytest.raises(ValueError, match='Snapshot budget'):
        Manager(root, max_snapshot_bytes=budget)
    assert not root.exists()


def test_daemon_descriptor_advertises_custom_snapshot_budget(tmp_path):
    from warpsph_remote.daemon import serve
    root = tmp_path / 'custom-budget'
    class Checked(Exception):
        pass
    def ready(info):
        assert info['maxSnapshotBytes'] == 512 * 1024**2
        assert descriptor(root)['maxSnapshotBytes'] == info['maxSnapshotBytes']
        raise Checked()
    with pytest.raises(Checked):
        serve(root, port=0, incidental=True, ready=ready, max_snapshot_bytes=512 * 1024**2)
    assert not (root / 'daemon.json').exists()


def test_public_telemetry_validation(api):
    manager, _, _ = api
    key = manager.register(dict(name="monitoring", pid=123))
    manager.status(key, dict(performance=dict(stepMs=2, targetTime=10),
        resources=dict(sampledAt=100, processRamBytes=1024, gpus=[])))
    public = manager.public(manager.runs[key])
    assert public['performance']['stepMs'] == 2
    assert public['resources']['processRamBytes'] == 1024
    with pytest.raises(ValueError):
        manager.status(key, dict(performance=dict(stepMs=float('inf'))))


def test_old_daemon_without_telemetry_capability(api, monkeypatch):
    from types import SimpleNamespace as NS
    manager, _, endpoint = api
    info = dict(endpoint=endpoint, producerToken=manager.producer_token)
    (manager.root / "daemon.json").write_text(json.dumps(info))
    (manager.root / "daemon.json").chmod(0o600)
    request = SimulationPublisher._request
    def old_register(self, path, data, headers=None):
        result = request(self, path, data, headers)
        if path == '/producer/runs':
            result.pop('features', None)
        return result
    monkeypatch.setattr(SimulationPublisher, '_request', old_register)
    publisher = SimulationPublisher('old daemon', runtime=manager.root, autostart=False, interval=.01)
    try:
        assert not publisher.telemetry_supported
        publisher.resources.sample = lambda: pytest.fail('Old daemon must not be sent resource telemetry')
        ctx = NS(spec=NS(store=False), scratch={}, config=NS(dt=.01), scheme='test')
        publisher.post_step(ctx, NS(t=.01, state=NS(positions=np.zeros((2,2)))), 1)
        assert 'performance' not in publisher.meta
        wait_for(lambda: manager.runs[publisher.id].get('step') == 1)
    finally:
        publisher.close()
