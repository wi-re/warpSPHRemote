"""Kill/restart a private daemon while a real TGV is paused, then resume and stop.

Uses only fixture-owned processes; no user daemon is contacted. Requires the
warpSPH interpreter passed as --python. Keep --output outside source and fresh.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    runtime = root/'runtime'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port = sock.getsockname()[1]
    endpoint = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'XDG_STATE_HOME':str(root/'pairing-state'), 'WARPSPH_COMPILE_WALLS':'1'}
    daemon = None
    logs = []
    key = None
    info = None
    def wait(predicate, timeout=90):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                result = predicate()
                if result: return result
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(.05)
        raise TimeoutError('Fixture recovery timed out; inspect fixture-owned logs.')
    def request(path, data=None):
        with urlopen(Request(endpoint+path,
            data=None if data is None else json.dumps(data).encode(), headers={
                'Authorization':'Bearer '+info['token'], 'Content-Type':'application/json',
                'X-Viewer-Id':'recovery-smoke-viewer'}), timeout=15) as response:
            return json.load(response) if response.status != 204 else None
    def start(index):
        nonlocal daemon, info
        log = open(root/f'daemon-{index}.log','wb'); logs.append(log)
        daemon = subprocess.Popen([args.python, '-m','warpsph_remote.daemon', '--runtime',str(runtime),
            '--port',str(port),'--python',args.python,'--incidental'], env=env, stdout=log, stderr=subprocess.STDOUT)
        def ready():
            nonlocal info
            candidate=json.loads((runtime/'daemon.json').read_text())
            if candidate['pid'] != daemon.pid:return False
            info=candidate
            return request('/v1/session')
        wait(ready)
    def row():
        return next((run for run in request('/v1/runs')['runs'] if run['id']==key), {})
    report = {}
    try:
        start(1)
        browser_token = info['token']
        run=request('/v1/runs',dict(preset='tgv-wc',nx=32,duration=10,steps=100000,record=False))
        key=run['id']
        wait(lambda:row().get('status')=='running')
        request(f'/v1/runs/{key}/pause',{})
        paused=wait(lambda:(r:=row()).get('status')=='paused' and r)
        config=wait(lambda:request(f'/v1/runs/{key}/configuration'))
        assert config.get('schemaVersion') == 1 and config.get('simulationConfig') and config.get('solverConfig')
        (root/'configuration.json').write_text(json.dumps(config,indent=2)+'\n')
        daemon.kill(); daemon.wait(timeout=10)
        time.sleep(.5)
        os.kill(paused['pid'],0)
        start(2)
        recovered=wait(lambda:(r:=row()).get('status')=='paused' and r.get('step')==paused['step'] and r)
        assert info['token']==browser_token
        assert recovered['pid']==paused['pid'] and recovered['pauseRequested']
        time.sleep(.3)
        assert row()['step']==paused['step']
        # Graceful daemon restart must preserve this same paused integrator too.
        daemon.send_signal(signal.SIGTERM); daemon.wait(timeout=10)
        os.kill(paused['pid'],0)
        start(3)
        recovered_again=wait(lambda:(r:=row()).get('status')=='paused' and r.get('step')==paused['step'] and r)
        request(f'/v1/runs/{key}/resume',{})
        resumed=wait(lambda:(r:=row()).get('step',0)>paused['step']+5 and r)
        request(f'/v1/runs/{key}/stop',{})
        stopped=wait(lambda:(r:=row()).get('status')=='stopped' and r)
        report=dict(run=key,pid=paused['pid'],pausedStep=paused['step'],resumedStep=resumed['step'],
            crashRecovery=True,gracefulRecovery=True,pausePreserved=True,pairingPreserved=True,
            stoppedNormally=stopped['status']=='stopped',recordingDisabled=True)
        (root/'checks.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)
    finally:
        if daemon and daemon.poll() is None:
            if key and info:
                try:
                    request(f'/v1/runs/{key}/stop',{})
                    wait(lambda:row().get('status') in ('stopped','completed','failed'),timeout=15)
                except (OSError, ValueError):pass
            daemon.terminate()
            try:daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:daemon.kill();daemon.wait(timeout=5)
        for log in logs:log.close()


if __name__=='__main__': main()
