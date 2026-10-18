"""Real step-based video and trajectory export, independent of the user's daemon and simulations."""
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
    parser.add_argument('--nx',type=int,default=32)
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
        row=manager.launch(dict(preset='tgv-wc',scheme='deltaSPH',variant='standard',
            nx=args.nx,duration=10,steps=11,paused=True,measurements=True,record=True,exportEverySteps=4,
            video=dict(fps=30,everySteps=3)))
        key=row['id']
        wait_for(lambda:manager.runs[key].get('registered'))
        manager.attach(key,viewer)
        wait_for(lambda:manager.runs[key].get('snapshot') and manager.runs[key].get('configuration'))
        row=manager.runs[key]
        assert row['time']==0 and row['step']==0 and row['status']=='paused'
        assert row['metadata']['videoArmed']==dict(fps=30,interval=.04,everySteps=3)
        assert row['particles']==args.nx**2
        configuration_bytes=len(json.dumps(row['configuration']).encode())
        assert configuration_bytes<65536,configuration_bytes
        result=dict(nx=args.nx,particles=row['particles'],configurationBytes=configuration_bytes,
            snapshotBytes=len(row['snapshot']),previewSeconds=time.monotonic()-started,
            initialTime=row['time'],initialStep=row['step'])
        manager.video_capture(key,viewer,dict(active=True,adopt=True,everySteps=3))
        manager.pause(key,False)
        from urllib.request import Request,urlopen
        captured=[]
        while True:
            wait_for(lambda:row.get('snapshot') is not None or row['status'] in ('completed','stopped'))
            if row.get('snapshot') is not None:
                captured.append(row['metadata']['step'])
                req=Request(f'http://127.0.0.1:{server.server_port}/v1/runs/{key}/ack',data=json.dumps(dict(sequence=row['sequence'])).encode(),headers={'Authorization':'Bearer '+manager.token,'X-Viewer-Id':viewer,'Content-Type':'application/json'})
                with urlopen(req,timeout=5) as response:json.load(response)
            if row['status'] in ('completed','stopped'):break
        wait_for(lambda:row['process'].poll() is not None)
        assert row['status']=='completed'
        assert captured==[0,3,6,9,11],captured
        import h5py
        with h5py.File(row['recording']['path'],'r') as f:
            trajectory_frames=len(f['times'])
        estimate=row['storageEstimate']
        assert estimate['everySteps']==4 and estimate['frames']==trajectory_frames==4
        result.update(videoSteps=captured,trajectoryFrames=trajectory_frames,storageEstimate=estimate,
            trajectoryBytes=Path(row['recording']['path']).stat().st_size)
        result.update(finalTime=row['time'],finalStep=row['step'],status=row['status'])
        (args.output/'results.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result,indent=2),flush=True)
    finally:
        manager.shutdown()
        if key and manager.runs[key].get('process'):
            manager.runs[key]['process'].wait(timeout=15)
        server.shutdown();server.server_close();thread.join()

if __name__=='__main__':main()
