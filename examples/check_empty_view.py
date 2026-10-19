"""Isolated history/live fixture for empty viewport browser checks; no solver required.

Output must be a fresh directory outside source. --browser serves on 18771 for
15 minutes (or until output/stop.request exists). Otherwise verify forget guards
and file retention using the existing authenticated API.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
from warpsph_remote.daemon import Handler, Manager
from warpsph_remote.publisher import SimulationPublisher


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--browser',action='store_true')
    args=parser.parse_args()
    root=args.output.resolve();root.mkdir(parents=True,exist_ok=False)
    os.environ['XDG_STATE_HOME']=str(root/'pairing-state')
    manager=Manager(root/'runtime',origins=['http://127.0.0.1:5177'])
    manager.catalogue=[] # This fixture never launches a solver.
    manager.token='empty-view-private-fixture'
    server=ThreadingHTTPServer(('127.0.0.1',18771 if args.browser else 0),partial(Handler,manager=manager))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    endpoint=f'http://127.0.0.1:{server.server_port}'
    (manager.root/'daemon.json').write_text(json.dumps(dict(endpoint=endpoint,producerToken=manager.producer_token)))
    (manager.root/'daemon.json').chmod(0o600)
    finished=[]
    for status in ('completed','failed','stopped'):
        key=manager.register(dict(name=f'{status} · UI fixture',pid=os.getpid(),measurements=True))
        manager.status(key,dict(status=status,step=2,time=.02))
        folder=manager.library.root/'runs'/key;folder.mkdir(parents=True)
        (folder/'simulation.log').write_text('Fixture log retained.\n')
        (folder/'export.fixture').write_text('Fixture export retained.\n')
        finished.append(key)
    publisher=SimulationPublisher('Paused particles · UI fixture',runtime=manager.root,autostart=False)
    manager.pause(publisher.id,True)
    values=dict(positions=np.array([[-.5,-.5],[-.5,.5],[.5,-.5],[.5,.5]],dtype='f4'),UIDs=np.arange(4,dtype='i8'),
        kinds=np.zeros(4,dtype='i4'),masses=np.ones(4,dtype='f4'),densities=np.ones(4,dtype='f4'),
        supports=np.full(4,.5,dtype='f4'),velocities=np.zeros((4,2),dtype='f4'))
    def request(path,data=None):
        return urlopen(Request(endpoint+path,data=None if data is None else json.dumps(data).encode(),headers={
            'Authorization':'Bearer '+manager.token,'Content-Type':'application/json'}),timeout=5)
    try:
        print(endpoint+' · token empty-view-private-fixture',flush=True)
        if args.browser:
            deadline=time.monotonic()+900
            while time.monotonic()<deadline and not (root/'stop.request').exists():
                publisher.update(status='paused',step=0,time=0,dt=.01,particles=4)
                if publisher.wants_snapshot:
                    publisher.snapshot(values,step=0,time_value=0,domain=dict(min=[-1,-1],max=[1,1],periodic=[False,False]))
                (root/'runs.json').write_text(json.dumps([manager.public(r) for r in manager.runs.values()],indent=2))
                time.sleep(.1)
        else:
            for key in finished:
                result=json.load(request(f'/v1/runs/{key}/forget',{}));assert result['filesRetained']
            try:request(f'/v1/runs/{publisher.id}/forget',{})
            except HTTPError as error:assert error.code==409
            else:raise AssertionError('Active producer must not be forgotten')
            assert set(manager.runs)=={publisher.id}
            assert all((manager.library.root/'runs'/key/'simulation.log').exists() and
                       (manager.library.root/'runs'/key/'export.fixture').exists() for key in finished)
            assert {r['id'] for r in manager.library.load()}=={publisher.id}
            (root/'checks.json').write_text(json.dumps(dict(finishedForgotten=3,activeRetained=True,filesRetained=True)))
    finally:
        publisher.close('stopped')
        manager.shutdown();server.shutdown();server.server_close()


if __name__=='__main__':main()
