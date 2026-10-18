"""Verify a managed TGV waits at its true initial state before video attachment.

--browser serves an isolated daemon for the launch wizard instead of auto-checks.
No user daemon/process is used. Choose a fresh evidence directory outside source.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import subprocess
import time
from urllib.request import Request,urlopen
from warpsph_remote.daemon import Manager,Handler


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--python',required=True)
    parser.add_argument('--browser',action='store_true')
    args=parser.parse_args()
    root=args.output.resolve();root.mkdir(parents=True,exist_ok=False,mode=0o700)
    os.environ['XDG_STATE_HOME']=str(root/'pairing-state')
    os.environ['WARPSPH_COMPILE_WALLS']='1'
    manager=Manager(root/'runtime',python=args.python,origins=['http://127.0.0.1:5175'])
    manager.token='initial-video-browser-fixture'
    cases=manager.available_cases()
    manager.catalogue=[{**c,'nx':16,'duration':.01} for c in cases if c['id']=='tgv-wc']
    assert manager.catalogue and manager.catalogue[0].get('available') is not False
    server=ThreadingHTTPServer(('127.0.0.1',18769 if args.browser else 0),partial(Handler,manager=manager))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    endpoint=f'http://127.0.0.1:{server.server_port}'
    descriptor=root/'runtime'/'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint=endpoint,producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    viewer='initial-video-check-viewer'
    def request(path,data=None):
        return urlopen(Request(endpoint+path,data=None if data is None else json.dumps(data).encode(),headers={
            'Authorization':'Bearer '+manager.token,'X-Viewer-Id':viewer,'Content-Type':'application/json'}),timeout=10)
    def wait(predicate):
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            result=predicate()
            if result:return result
            time.sleep(.03)
        raise TimeoutError('Inspect the fixture-owned simulation log.')
    try:
        if args.browser:
            print(f'{endpoint} · token initial-video-browser-fixture',flush=True)
            deadline=time.monotonic()+900
            while time.monotonic()<deadline:
                if (root/'stop.request').exists():break
                (root/'runs.json').write_text(json.dumps([manager.public(r) for r in manager.runs.values()],indent=2))
                time.sleep(.2)
            return
        run=json.load(request('/v1/runs',dict(preset='tgv-wc',nx=16,steps=4,duration=.01,video=dict(fps=24,interval=.01))))
        key=run['id'];r=manager.runs[key]
        wait(lambda:r.get('registered') and r.get('status')=='paused')
        time.sleep(.2)
        assert r['time']==0 and r['step']==0 and r['sequence']==0
        request(f'/v1/runs/{key}/attach',{}).close()
        wait(lambda:r['sequence']==1)
        first=r['metadata'].copy();packet=r['snapshot']
        assert first['time']==0 and first['videoArmed']==dict(fps=24,interval=.01)
        time.sleep(.2);assert r['time']==0
        request(f'/v1/runs/{key}/video',dict(active=True,interval=.01,adopt=True)).close()
        assert r['snapshot'] is packet and r['sequence']==1
        request(f'/v1/runs/{key}/resume',{}).close()
        time.sleep(.1);assert r['time']==0  # Play still needs the configured initial render ACK.
        times=[]
        for _ in range(20):
            if r['snapshot'] is not None:
                times.append(r['metadata']['time'])
                request(f'/v1/runs/{key}/ack',dict(sequence=r['sequence'])).close()
            wait(lambda:r['snapshot'] is not None or r.get('status') in ('completed','failed','stopped'))
            if r.get('status') in ('completed','failed','stopped'):break
        assert r['status']=='completed' and times[0]==0 and times[-1]>0
        assert not r.get('recording')
        checks=dict(initialTime=first['time'],initialParticles=r['particles'],frameTimes=times,
            noStepsBeforeRender=True,adoptPreservesSnapshot=True,status=r['status'],recordingDisabled=True)
        (root/'checks.json').write_text(json.dumps(checks,indent=2)+'\n');print(json.dumps(checks),flush=True)
    finally:
        for key in list(manager.runs):
            if manager.runs[key].get('status') not in ('completed','failed','stopped'):manager.stop(key)
        manager.shutdown()
        for run in manager.runs.values():
            process=run.get('process')
            if process is not None:
                try:process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=5)
        server.shutdown();server.server_close()


if __name__=='__main__':main()
