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
    assert set(session["features"]) == {"pause", "recordedHistory", "configuration"}
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
