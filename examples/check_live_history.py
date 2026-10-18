"""Exercise a real managed run: pause, live capture, growing disk history, resume, stop.

Requires warpSPH in --python. All generated logs/exports stay in a fresh --output
outside source. This starts a private ephemeral daemon, never the user's daemon.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from urllib.request import Request, urlopen

from warpsph_remote.daemon import Handler, Manager
from warpsph_remote.protocol import validate_packet


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--python',required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    manager=Manager(args.output/'runtime',python=args.python)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,manager=manager))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    endpoint=f'http://127.0.0.1:{server.server_port}'
    descriptor=manager.root/'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint=endpoint,producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    def request(path,data=None):
        return urlopen(Request(endpoint+path,data=json.dumps(data).encode() if data is not None else None,
            headers={'Authorization':'Bearer '+manager.token,'Content-Type':'application/json',
                     'X-Viewer-Id':'history-smoke-viewer'}),timeout=12)
    def json_request(path,data=None):
        with request(path,data) as response:return json.load(response)
    def wait(predicate,timeout=120):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            result=predicate()
            if result:return result
            time.sleep(.05)
        raise TimeoutError('Real solver did not reach the expected state; inspect simulation.log.')
    report={}
    try:
        run=json_request('/v1/runs',dict(preset='tgv-wc',nx=32,duration=10,steps=100000,
                                        record=True,exportInterval=.001))
        key=run['id']
        def row():return next(r for r in json_request('/v1/runs')['runs'] if r['id']==key)
        wait(lambda:row().get('registered'))
        json_request(f'/v1/runs/{key}/pause',{})
        first_pause=wait(lambda:(lambda r: r if r['status']=='paused' else None)(row()))
        time.sleep(.15)
        assert row()['step']==first_pause['step']
        json_request(f'/v1/runs/{key}/resume',{})
        wait(lambda:row().get('step',0)>first_pause['step']+5)
        json_request(f'/v1/runs/{key}/pause',{})
        paused=wait(lambda:(lambda r: r if r['status']=='paused' else None)(row()))
        history=json_request(f'/v1/runs/{key}/history')
        assert history['frames']>0
        with request(f'/v1/runs/{key}/history/frame?index=0&field=velocities') as response:
            frame=validate_packet(response.read())
        assert frame['index']==0
        json_request(f'/v1/runs/{key}/attach',{})
        def snapshot():
            with request(f'/v1/runs/{key}/snapshot') as response:
                return validate_packet(response.read()) if response.status==200 else None
        wait(snapshot)
        assert row()['step']==paused['step']
        json_request(f'/v1/runs/{key}/resume',{})
        wait(lambda:row().get('step',0)>paused['step']+5)
        json_request(f'/v1/runs/{key}/pause',{})
        wait(lambda:row()['status']=='paused')
        growing=json_request(f'/v1/runs/{key}/history')
        assert growing['frames']>history['frames']
        json_request(f'/v1/runs/{key}/stop',{})
        stopped=wait(lambda:(lambda r: r if r['status']=='stopped' else None)(row()))
        final=json_request(f'/v1/runs/{key}/history')
        assert final['frames']>=growing['frames']
        manager.runs[key]['process'].wait(timeout=30)
        report=dict(pauseStep=first_pause['step'],historyFrames=history['frames'],
                    growingFrames=growing['frames'],finalFrames=final['frames'],stopped=stopped['status'])
        # A normal launch must not generate trajectories.
        plain=json_request('/v1/runs',dict(preset='tgv-wc',nx=16,duration=.001,steps=2))
        plain_id=plain['id']
        wait(lambda:manager.runs[plain_id]['status'] in ('completed','failed'))
        manager.runs[plain_id]['process'].wait(timeout=30)
        assert manager.runs[plain_id]['status']=='completed'
        assert not list((manager.root/'runs'/plain_id).rglob('*.h5'))
        report['defaultRecordingDisabled']=True
        (args.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)
    finally:
        manager.shutdown();server.shutdown();server.server_close();thread.join()
        # Pairing credentials are ephemeral, not development evidence.
        descriptor.unlink(missing_ok=True)


if __name__=='__main__':main()
