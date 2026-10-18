"""Check dimension/integrator dispatch and saved rerun requests on a private daemon.

Requires an installed warpSPH environment and CUDA. Output must be outside source.
--browser keeps a fixture daemon available on 18770 for UI checks (token printed).
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import time

from warpsph_remote.daemon import Handler, Manager


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--browser',action='store_true')
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    os.environ['XDG_STATE_HOME']=str(args.output/'pairing')
    manager=Manager(args.output/'runtime',python=args.python,origins=['http://127.0.0.1:5176'])
    manager.token='launch-parameters-private-fixture'
    manager.catalogue=[c for c in manager.available_cases() if c['id'] in ('sedov','sod')]
    server=ThreadingHTTPServer(('127.0.0.1',18770 if args.browser else 0),partial(Handler,manager=manager))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    descriptor=manager.root/'daemon.json'
    descriptor.write_text(json.dumps(dict(endpoint=f'http://127.0.0.1:{server.server_port}',producerToken=manager.producer_token)))
    descriptor.chmod(0o600)
    key=None
    def wait(condition):
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            row=manager.runs[key]
            if row['status']=='failed':raise AssertionError(manager.public(row))
            if row.get('lease'):manager.attach(key,'launch-parameters-private-viewer')
            if condition():return
            time.sleep(.05)
        raise AssertionError('Timed out; inspect the private simulation log.')
    try:
        checks=[]
        for method in ('rungeKutta2','rungeKutta4','symplecticEuler'):
            request=dict(preset='sedov',scheme='Monaghan' if method=='symplecticEuler' else 'CRKSPH',variant='default',nx=16,duration=1,steps=2,paused=True,
                configuration={'simulation':{'dim':2,'integrationScheme':method}})
            row=manager.launch(request);key=row['id']
            wait(lambda:manager.runs[key].get('registered'))
            manager.attach(key,'launch-parameters-private-viewer')
            wait(lambda:manager.runs[key].get('snapshot') and manager.runs[key].get('configuration'))
            row=manager.runs[key]
            assert row['metadata']['dimension']==2,row['metadata']
            assert row['metadata']['step']==0
            assert row['launch']['configuration']==request['configuration']
            first=dict(dimension=row['metadata']['dimension'],particles=row['particles'],method=method,scheme=request['scheme'])
            manager.pause(key,False)
            wait(lambda:row['status']=='completed' and row['process'].poll() is not None)
            first.update(step=row['step'],status=row['status'])
            checks.append(first)
        (args.output/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
        print(json.dumps(checks),flush=True)
        if args.browser:
            print('http://127.0.0.1:18770 · token launch-parameters-private-fixture',flush=True)
            deadline=time.monotonic()+900
            while time.monotonic()<deadline and not (args.output/'stop.request').exists():time.sleep(.2)
    finally:
        for run_id,row in list(manager.runs.items()):
            if row['status'] not in ('completed','failed','stopped'):manager.stop(run_id)
        manager.shutdown()
        for row in manager.runs.values():
            process=row.get('process')
            if process:
                try:process.wait(timeout=8)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        server.shutdown();server.server_close()


if __name__=='__main__':main()
