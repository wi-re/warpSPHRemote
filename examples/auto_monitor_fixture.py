"""Isolated companion for browser auto-attach/monitor regression checks.

--python selects a working warpSPH interpreter for actual preset launches.
Create external-N.start in --output to register a synthetic external producer.
Use a fresh output directory outside source; Ctrl+C ends all fixture-owned runs.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from types import SimpleNamespace as NS
import threading
import time
import uuid
import subprocess

import numpy as np
from warpsph_remote.daemon import Handler, Manager
from warpsph_remote.publisher import SimulationPublisher, SimulationStopped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--seconds', type=float, default=900)
    args = parser.parse_args()
    if not np.isfinite(args.seconds) or args.seconds <= 0:
        parser.error('seconds must be finite and positive')
    root = args.output.resolve()
    if root.exists():
        parser.error('choose a fresh output directory outside source')
    manager = Manager(root, python=args.python)
    manager.token = 'auto-monitor-test-token'
    server = ThreadingHTTPServer(('127.0.0.1', 18768), partial(Handler, manager=manager))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    descriptor = root / 'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint='http://127.0.0.1:18768', producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    axis = np.linspace(0, 1, 16, dtype=np.float32)
    positions = np.stack(np.meshgrid(axis, axis), axis=-1).reshape(-1, 2)
    n = len(positions)
    state = NS(positions=positions, velocities=np.ones((n, 2), np.float32)*.1,
               densities=np.ones(n, np.float32), supports=np.ones(n, np.float32)*.15,
               masses=np.ones(n, np.float32)/n, kinds=np.zeros(n, np.int32), UIDs=np.arange(n, dtype=np.int64))
    ctx = NS(spec=NS(store=False), scratch={}, exportPath=None, scheme='synthetic',
             config=NS(dt=.01, domain=NS(min=np.zeros(2), max=np.ones(2), periodic=np.ones(2, dtype=bool))))
    publishers = []
    workers = []
    closing = threading.Event()
    def external(name, delayed_key=None):
        if delayed_key:
            while not (root / 'register-delayed').exists():
                if closing.wait(.05):
                    return
        class Publisher(SimulationPublisher):
            def _request(self, path, data, headers=None):
                if delayed_key and path == '/producer/runs':
                    data = {**data, 'id': delayed_key}
                return super()._request(path, data, headers)
        publisher = Publisher(name, runtime=root, autostart=False, interval=.02)
        publishers.append(publisher)
        try:
            for step in range(100000):
                if closing.is_set():
                    break
                publisher.post_step(ctx, NS(t=step*.01, state=state), step)
                time.sleep(.02)
        except SimulationStopped:
            pass
        finally:
            publisher.close('stopped')
    print('Isolated companion: http://127.0.0.1:18768 · token auto-monitor-test-token', flush=True)
    seen = set()
    deadline = time.monotonic() + args.seconds
    try:
        while time.monotonic() < deadline:
            for path in root.glob('external-*.start'):
                if path.name not in seen:
                    seen.add(path.name)
                    name = path.stem.replace('-', ' ').title()
                    delayed_key = None
                    if 'delayed' in path.stem:
                        delayed_key = uuid.uuid4().hex
                        with manager.lock:
                            manager.runs[delayed_key] = dict(id=delayed_key, name=name,
                                startedAt=time.time(), updatedAt=time.time(), status='starting',
                                registered=False, sequence=0, createdBy='simulation')
                            manager.touch()
                    thread = threading.Thread(target=external, args=(name, delayed_key), daemon=True)
                    workers.append(thread)
                    thread.start()
            time.sleep(.05)
    except KeyboardInterrupt:
        pass
    finally:
        closing.set()
        for publisher in publishers:
            publisher.stopping.set()
        for thread in workers:
            thread.join(timeout=3)
        manager.shutdown()
        for run in list(manager.runs.values()):
            process = run.get('process')
            if process is not None:
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        server.shutdown()
        server.server_close()
        descriptor.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
