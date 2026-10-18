"""Reproduce a recorded triplePoint nx=256 live attachment in an isolated daemon.

PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 python examples/check_large_live.py \
  --python /path/to/warp/bin/python --output /tmp/triplepoint-live-check
Use a fresh output directory outside source. Only fixture-owned runs are stopped.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
import time
from urllib.request import Request, urlopen

from warpsph_remote.daemon import Handler, Manager
from warpsph_remote.protocol import validate_packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    if root.exists():
        parser.error('choose a fresh output directory outside source')
    manager = Manager(root, python=args.python)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, manager=manager))
    endpoint = f'http://127.0.0.1:{server.server_port}'
    descriptor = root / 'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint=endpoint, producerToken=manager.producer_token,
                                         maxSnapshotBytes=manager.max_snapshot_bytes)))
    descriptor.chmod(0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def request(path, data=None):
        body = None if data is None else json.dumps(data).encode()
        with urlopen(Request(endpoint + path, data=body, headers={
            'Authorization': 'Bearer ' + manager.token, 'Content-Type': 'application/json',
            'X-Viewer-Id': 'viewer-large-frame-check'}), timeout=90) as response:
            if response.status == 204:
                return None
            if response.headers['Content-Type'].startswith('application/json'):
                return json.load(response)
            body = response.read()
            return dict(bytes=len(body), header=validate_packet(body),
                        sequence=int(response.headers.get('X-Snapshot-Sequence', '0')),
                        metadata=json.loads(response.headers.get('X-Snapshot-Metadata', '{}')))

    def wait(predicate):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError('Timed out; inspect fixture-owned runs/*/simulation.log')

    try:
        run = request('/v1/runs', dict(preset='triplePoint', nx=256, scheme='CRKSPH',
            record=True, exportInterval=.01, duration=1, steps=500, configuration={}))
        key = run['id']
        base = f'/v1/runs/{key}'
        def row():
            return next(r for r in request('/v1/runs')['runs'] if r['id'] == key)
        wait(lambda: row().get('registered'))
        request(base + '/attach', {})
        first = wait(lambda: request(base + '/snapshot'))
        assert first['header']['arrays']['positions']['shape'][0] > 600000
        assert {'pressures', 'internalEnergies'} <= first['header']['arrays'].keys()
        statics = request(base + '/static')
        request(base + '/pause', {})
        paused = wait(lambda: (r := row())['status'] == 'paused' and r)
        request(base + '/ack', dict(sequence=first['sequence']))
        second = wait(lambda: request(base + '/snapshot'))
        assert second['sequence'] > first['sequence']
        history = request(base + '/history')
        request(base + '/resume', {})
        wait(lambda: row().get('step', 0) > paused['step'] + 20)
        request(base + '/pause', {})
        wait(lambda: row()['status'] == 'paused')
        history2 = request(base + '/history')
        assert history2['frames'] > history['frames']
        recorded = request(base + '/history/frame?index=0&field=densities')
        assert recorded['header']['arrays']['positions']['shape'] == first['header']['arrays']['positions']['shape']
        result = dict(particles=row()['particles'], first=first, statics=statics,
                      second=second, historyFrames=[history['frames'], history2['frames']],
                      recordedFrameBytes=recorded['bytes'])
        (root / 'checks.json').write_text(json.dumps(result, indent=2))
        print(f"{result['particles']:,} particles; live snapshots and pause/resume passed; "
              f"recorded history grew {result['historyFrames']}. Evidence: {root}")
    finally:
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
