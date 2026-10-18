"""Authenticated lease handoff and recovery of a paused producer across daemon death."""
from functools import partial
from http.server import ThreadingHTTPServer
import json
from types import SimpleNamespace as NS
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import numpy as np
import pytest

from warpsph_remote.daemon import Manager, Handler, Conflict
from warpsph_remote.publisher import SimulationPublisher, SimulationStopped
from warpsph_remote.protocol import encode_frame


def wait(predicate, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.02)
    raise AssertionError('Recovery condition did not arrive')


class Daemon:
    def __init__(self, root):
        self.manager = Manager(root)
        self.manager.catalogue = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, manager=self.manager))
        self.endpoint = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        path = root / 'daemon.json'
        path.write_text(json.dumps(dict(endpoint=self.endpoint, producerToken=self.manager.producer_token)))
        path.chmod(0o600)

    def call(self, path, data=None, viewer='viewer-aaaaaaaaaaaa', producer=False):
        token = self.manager.producer_token if producer else self.manager.token
        return urlopen(Request(self.endpoint + path,
            data=None if data is None else json.dumps(data).encode(), headers={
                'Authorization':'Bearer '+token, 'Content-Type':'application/json', 'X-Viewer-Id':viewer}), timeout=3)

    def close(self):
        self.manager.shutdown(stop_runs=False)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def test_takeover_is_explicit_atomic_and_old_requests_cannot_reclaim(tmp_path):
    daemon = Daemon(tmp_path/'runtime')
    m = daemon.manager
    key = m.register(dict(name='paused simulation', pid=123))
    other = m.register(dict(name='other simulation', pid=124))
    m.status(key, dict(status='paused', step=3, time=.3))
    m.pause(key, True)
    old = 'viewer-aaaaaaaaaaaa'
    new = 'viewer-bbbbbbbbbbbb'
    try:
        m.attach(key, old)
        generation = m.runs[key]['captureGeneration']
        with pytest.raises(HTTPError) as error:
            daemon.call(f'/v1/runs/{key}/attach', {}, new)
        assert error.value.code == 409
        assert json.load(error.value)['code'] == 'viewer_conflict'
        assert m.runs[key]['lease'] == old
        daemon.call(f'/v1/runs/{key}/attach', dict(takeover=True), new).close()
        assert m.runs[key]['lease'] == new
        assert m.runs[key]['pause'] and m.runs[key]['status'] == 'paused'
        assert m.runs[key]['captureGeneration'] > generation
        for action, body in [('attach', {}), ('ack', dict(sequence=0)), ('detach', {})]:
            with pytest.raises(HTTPError) as stale:
                daemon.call(f'/v1/runs/{key}/{action}', body, old)
            assert stale.value.code == 409
            assert m.runs[key]['lease'] == new
        static = encode_frame(dict(UIDs=np.array([1])), index=0, time=.3)
        dynamic = encode_frame(dict(positions=np.zeros((1, 2))), index=0, time=.3)
        packet = struct.pack('<II', len(static), len(dynamic)) + static + dynamic
        with pytest.raises(Conflict):
            m.upload(key, packet, {}, 'r', generation)
        m.upload(key, packet, {}, 'r', m.runs[key]['captureGeneration'])
        # A different target can take over the daemon's single resident viewer.
        m.attach(other, old, takeover=True)
        assert m.runs[key]['snapshot'] is None and m.runs[key]['static'] is None
        assert m.runs[other]['lease'] == old
        assert m.runs[key]['pause']
        # Invalid takeover must not evict the current viewer.
        m.status(key, dict(status='completed'))
        with pytest.raises(Conflict):
            m.attach(key, new, takeover=True)
        assert m.runs[other]['lease'] == old
        for invalid in ('true', 1, None):
            with pytest.raises(ValueError):
                m.attach(other, new, takeover=invalid)
            assert m.runs[other]['lease'] == old
    finally:
        daemon.close()


def test_pending_terminal_snapshot_can_be_transferred_without_new_capture(tmp_path):
    daemon = Daemon(tmp_path/'runtime')
    m = daemon.manager
    try:
        key = m.register(dict(name='final frame'))
        m.attach(key, 'viewer-aaaaaaaaaaaa')
        m.runs[key].update(snapshot=b'frame', static=b'identities', staticRevision='r', status='completed')
        m.attach(key, 'viewer-bbbbbbbbbbbb', takeover=True)
        assert m.runs[key]['snapshot'] == b'frame' and m.runs[key]['static'] == b'identities'
        assert not m.runs[key]['capture']
    finally:
        daemon.close()


def test_paused_producer_recovers_new_credentials_and_can_resume_and_stop(tmp_path):
    root = tmp_path/'runtime'
    first = Daemon(root)
    second = None
    publisher = SimulationPublisher('surviving run', runtime=root, autostart=False, interval=.02)
    original_id, started_at = publisher.id, publisher.started_at
    values = NS(positions=np.zeros((2,2)), velocities=np.ones((2,2)), densities=np.ones(2),
        supports=np.ones(2), masses=np.ones(2), kinds=np.zeros(2, dtype=np.int32), UIDs=np.arange(2))
    ctx = NS(spec=NS(store=False, tLimit=100), scratch={}, scheme='test',
        config=NS(dt=.001, domain=NS(min=np.zeros(2), max=np.ones(2), periodic=np.ones(2,dtype=bool))))
    stopped = threading.Event()
    def simulation():
        try:
            for step in range(100000):
                publisher.post_step(ctx, NS(t=step*.001, state=values), step)
                time.sleep(.005)
        except SimulationStopped:
            stopped.set()
    worker = threading.Thread(target=simulation, daemon=True)
    worker.start()
    try:
        first.manager.pause(original_id, True)
        wait(lambda:first.manager.runs[original_id]['status']=='paused')
        paused_step = first.manager.runs[original_id]['step']
        first.close()  # Connection genuinely closes; producer and integrator survive.
        first = None
        time.sleep(.1)
        assert worker.is_alive() and publisher.pausing.is_set()
        second = Daemon(root)  # New port, producer token and empty registry.
        recovered = wait(lambda: second.manager.runs.get(original_id, {}).get('status') == 'paused' and second.manager.runs[original_id].get('step') == paused_step and second.manager.runs[original_id])
        assert publisher.id == original_id and recovered['startedAt'] == started_at
        assert recovered['step'] == paused_step and recovered['pause']
        assert recovered['pid'] == __import__('os').getpid()
        second.manager.attach(original_id, 'viewer-bbbbbbbbbbbb')
        wait(lambda: recovered.get('snapshot') is not None)
        sequence = recovered['sequence']
        second.call(f'/v1/runs/{original_id}/ack', dict(sequence=sequence), 'viewer-bbbbbbbbbbbb').close()
        # Taking over the acknowledged paused boundary also gets a fresh snapshot.
        second.manager.attach(original_id, 'viewer-cccccccccccc', takeover=True)
        wait(lambda: recovered['sequence'] > sequence)
        assert recovered['step'] == paused_step
        second.manager.pause(original_id, False)
        wait(lambda: recovered['step'] > paused_step)
        second.manager.stop(original_id)
        assert stopped.wait(5)
        worker.join(3)
        assert not worker.is_alive()
    finally:
        publisher.stopping.set()
        worker.join(3)
        publisher.close('stopped')
        if first: first.close()
        if second: second.close()


def test_recovery_registration_is_idempotent_and_does_not_override_commands(tmp_path):
    daemon = Daemon(tmp_path/'runtime')
    m = daemon.manager
    try:
        key = 'a'*32
        data = dict(name='survivor', pid=123, startedAt=100, paused=True, reconnect=True, managed=True)
        assert m.register(data, key) == key
        from warpsph_remote.catalogue import CATALOGUE
        m.catalogue = CATALOGUE
        assert m.public(m.runs[key])['createdBy'] == 'daemon'
        with pytest.raises(Conflict, match='managed preset'):
            m.launch(dict(preset='tgv-wc', nx=16, duration=1))
        m.attach(key, 'viewer-aaaaaaaaaaaa')
        m.pause(key, False)
        m.stop(key)
        assert m.register(data, key) == key
        assert m.runs[key]['lease'] == 'viewer-aaaaaaaaaaaa'
        assert not m.runs[key]['pause'] and m.runs[key]['stop']
        with pytest.raises(Conflict): m.register({**data, 'pid':124}, key)
        with pytest.raises(ValueError): m.register(data, '../bad')
        with pytest.raises(ValueError): m.register({**data, 'startedAt':float('nan')}, 'b'*32)
    finally:
        daemon.close()


def test_capture_being_encoded_cannot_cross_transport_recovery(tmp_path, monkeypatch):
    import warpsph_remote.captures as module
    daemon = Daemon(tmp_path/'runtime')
    publisher = SimulationPublisher('capture epoch', runtime=tmp_path/'runtime', autostart=False, interval=.02)
    try:
        daemon.manager.attach(publisher.id, 'viewer-aaaaaaaaaaaa')
        wait(lambda: publisher.wants_snapshot)
        original_encode = module.encode_frame
        interrupted = False
        def encode(*args, **kwargs):
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                assert publisher._recover()
            return original_encode(*args, **kwargs)
        monkeypatch.setattr(module, 'encode_frame', encode)
        assert publisher.snapshot(dict(positions=np.zeros((2,2)), UIDs=np.arange(2),
            kinds=np.zeros(2,dtype=np.int32), masses=np.ones(2), densities=np.ones(2),
            supports=np.ones(2), velocities=np.ones((2,2))), step=1,time_value=.1)
        wait(lambda: interrupted and not publisher._transfer_busy)
        assert publisher.pending is None
        assert daemon.manager.runs[publisher.id]["snapshot"] is None
    finally:
        publisher.close()
        daemon.close()
