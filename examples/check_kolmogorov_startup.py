"""Real high-resolution preview, independent of the user's daemon and simulations."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time

from warpsph_remote.daemon import Handler, Manager


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--python',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--nx',type=int,default=512)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    manager=Manager(args.output/'runtime',python=args.python)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,manager=manager))
    server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    descriptor=manager.root/'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint=f'http://127.0.0.1:{server.server_port}',producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    viewer='private-kolmogorov-startup'
    key=None
    def wait_for(condition,timeout=120):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if key:
                row=manager.runs[key]
                assert row.get('status')!='failed',manager.public(row)
                if row.get('lease'):manager.attach(key,viewer) # Keep the private lease alive.
            if condition():return
            time.sleep(.05)
        raise AssertionError('Timed out; inspect the private simulation.log')
    try:
        started=time.monotonic()
        row=manager.launch(dict(preset='kolmogorov',scheme='deltaSPH',variant='standard',
            nx=args.nx,duration=10,steps=2,paused=True,measurements=True,record=False,
            video=dict(fps=30,interval=.01)))
        key=row['id']
        wait_for(lambda:manager.runs[key].get('registered'))
        manager.attach(key,viewer)
        wait_for(lambda:manager.runs[key].get('snapshot') and manager.runs[key].get('configuration'))
        row=manager.runs[key]
        assert row['time']==0 and row['step']==0 and row['status']=='paused'
        assert row['metadata']['videoArmed']==dict(fps=30,interval=.01)
        assert row['particles']==args.nx**2
        configuration_bytes=len(json.dumps(row['configuration']).encode())
        assert configuration_bytes<65536,configuration_bytes
        result=dict(nx=args.nx,particles=row['particles'],configurationBytes=configuration_bytes,
            snapshotBytes=len(row['snapshot']),previewSeconds=time.monotonic()-started,
            initialTime=row['time'],initialStep=row['step'])
        # A preview is not a video render ACK. Explicitly disarm before running
        # this non-browser fixture, rather than silently releasing video holds.
        manager.video_capture(key,viewer,dict(active=False))
        manager.pause(key,False)
        wait_for(lambda:row['status'] in ('completed','stopped'))
        wait_for(lambda:row['process'].poll() is not None)
        assert row['status']=='completed'
        result.update(finalTime=row['time'],finalStep=row['step'],status=row['status'])
        (args.output/'results.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result,indent=2),flush=True)
    finally:
        manager.shutdown()
        if key and manager.runs[key].get('process'):
            manager.runs[key]['process'].wait(timeout=15)
        server.shutdown();server.server_close();thread.join()

if __name__=='__main__':main()
