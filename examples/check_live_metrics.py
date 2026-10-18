"""Verify timing, NVIDIA PID-attributed hardware, pause stability and live bytes on TGV.

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
                                        record=False))
        key=run['id']
        def row():return next(r for r in json_request('/v1/runs')['runs'] if r['id']==key)
        active=wait(lambda:(r:=row()).get('performance',{}).get('stepMs',0)>0 and r)
        hardware=wait(lambda:(r:=row()).get('resources',{}).get('gpus') and r)
        json_request(f'/v1/runs/{key}/attach',{})
        def snapshot():
            with request(f'/v1/runs/{key}/snapshot') as response:
                if response.status != 200:return None
                body=response.read()
                return dict(bytes=len(body),sequence=int(response.headers['X-Snapshot-Sequence']),
                            frame=validate_packet(body))
        first=wait(snapshot)
        with request(f'/v1/runs/{key}/static') as response:
            static_bytes=len(response.read())
        json_request(f'/v1/runs/{key}/pause',{})
        paused=wait(lambda:(r:=row())['status']=='paused' and r)
        time.sleep(2)
        assert row()['step']==paused['step']
        assert row()['performance']==paused['performance']
        json_request(f'/v1/runs/{key}/ack',dict(sequence=first['sequence']))
        # At most one final boundary (the state reached while the pause arrived).
        time.sleep(.2)
        final_boundary=snapshot()
        if final_boundary:
            json_request(f'/v1/runs/{key}/ack',dict(sequence=final_boundary['sequence']))
        time.sleep(.3)
        assert snapshot() is None
        json_request(f'/v1/runs/{key}/resume',{})
        resumed=wait(lambda:(r:=row()).get('step',0)>paused['step']+10 and r)
        assert resumed['performance']['stepMs']>0
        report=dict(active=active,hardware=hardware,paused=paused,resumed=resumed,
                    firstDynamicBytes=first['bytes'],firstStaticBytes=static_bytes,
                    pausedStateStable=True,recordingDisabled=True)
        json_request(f'/v1/runs/{key}/stop',{})
        wait(lambda:row()['status']=='stopped')
        manager.runs[key]['process'].wait(timeout=30)
        assert not list((manager.root/'runs'/key).rglob('*.h5'))
        (args.output/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)
    finally:
        manager.shutdown();server.shutdown();server.server_close();thread.join()
        # Pairing credentials are ephemeral, not development evidence.
        descriptor.unlink(missing_ok=True)


if __name__=='__main__':main()
