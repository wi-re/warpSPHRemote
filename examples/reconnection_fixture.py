"""Browser fixture: two viewers can take over a paused run; daemon can go offline.

Connect to port 18779 with token reconnection-fixture-token-xxxxxxxxxxxxxxxxxxxxxxxx.
Create offline.request in --output to stop only the child daemon; create
online.request to restart it. The producer survives both operations. Ctrl+C
stops this fixture and its daemon. All output stays outside source.
"""
import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace as NS
import subprocess
import sys
import threading
import time
import numpy as np
from warpsph_remote.daemon import descriptor
from warpsph_remote.pairing_token import persistent_token
from warpsph_remote.publisher import SimulationPublisher, SimulationStopped


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--port',type=int,default=18779)
    parser.add_argument('--seconds',type=float,default=1200)
    args=parser.parse_args()
    root=args.output.resolve()
    root.mkdir(mode=0o700,parents=True,exist_ok=False)
    os.environ['XDG_STATE_HOME']=str(root/'pairing-state')
    token='reconnection-fixture-token-'+'x'*24
    if persistent_token(initial=token)!=token:raise ValueError('Choose a fresh fixture root')
    runtime=root/'runtime'
    daemon=None
    logs=[]
    def start():
        nonlocal daemon
        log=open(root/f'daemon-{len(logs)}.log','wb');logs.append(log)
        daemon=subprocess.Popen([sys.executable,'-m','warpsph_remote.daemon','--runtime',str(runtime),
            '--port',str(args.port),'--python',sys.executable,'--incidental'],stdout=log,stderr=subprocess.STDOUT)
        until=time.monotonic()+10
        while time.monotonic()<until:
            try:
                if descriptor(runtime)['pid']==daemon.pid:return
            except (OSError,KeyError,ValueError):pass
            time.sleep(.02)
        raise RuntimeError('Fixture daemon failed to start')
    def stop():
        nonlocal daemon
        if daemon and daemon.poll() is None:
            daemon.terminate();daemon.wait(timeout=10)
        daemon=None
    start()
    publisher=SimulationPublisher('Restart and takeover verification',runtime=runtime,autostart=False,interval=.05)
    axis=np.linspace(0,1,16,dtype=np.float32)
    positions=np.stack(np.meshgrid(axis,axis),axis=-1).reshape(-1,2)
    n=len(positions)
    values=NS(positions=positions,velocities=np.ones((n,2),np.float32)*.1,densities=np.ones(n,np.float32),
        supports=np.ones(n,np.float32)*.15,masses=np.ones(n,np.float32)/n,
        kinds=np.zeros(n,np.int32),UIDs=np.arange(n,dtype=np.int64))
    ctx=NS(spec=NS(store=False,tLimit=1000),scratch={},scheme='fixture',
        config=NS(dt=.01,domain=NS(min=np.zeros(2),max=np.ones(2),periodic=np.ones(2,dtype=bool))))
    def simulate():
        try:
            for step in range(100000):
                publisher.post_step(ctx,NS(t=step*.01,state=values),step)
                time.sleep(.01)
        except SimulationStopped:pass
        finally:publisher.close('stopped')
    worker=threading.Thread(target=simulate,daemon=True);worker.start()
    print(f'Fixture: http://127.0.0.1:{args.port} · token {token}',flush=True)
    until=time.monotonic()+args.seconds
    try:
        while worker.is_alive() and time.monotonic()<until:
            if (root/'offline.request').exists():
                (root/'offline.request').unlink();stop()
            if (root/'online.request').exists():
                (root/'online.request').unlink()
                if daemon is None:start()
            time.sleep(.05)
    except KeyboardInterrupt:pass
    finally:
        publisher.stopping.set();worker.join(5)
        if worker.is_alive():publisher.closed.set();worker.join(2)
        stop()
        for log in logs:log.close()


if __name__=='__main__':main()
