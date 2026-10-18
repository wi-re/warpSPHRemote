"""Isolated real 1D launches; no user daemon or simulation is contacted."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from urllib.request import Request,urlopen

from warpsph_remote.daemon import Handler,Manager


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--python',required=True)
    parser.add_argument('--browser',action='store_true',help='Keep the private endpoint alive for UI checks.')
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    m=Manager(args.output/'runtime',python=args.python,origins=['http://127.0.0.1:5175'])
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,manager=m));server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    endpoint=f'http://127.0.0.1:{server.server_port}'
    (m.root/'daemon.json').write_text(json.dumps(dict(endpoint=endpoint,producerToken=m.producer_token,maxSnapshotBytes=m.max_snapshot_bytes)))
    (m.root/'daemon.json').chmod(0o600)
    def call(path,data=None):
        return urlopen(Request(endpoint+path,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+m.token,'Content-Type':'application/json','X-Viewer-Id':'1234567890abcdef1234567890abcdef'}),timeout=60)
    def wait(fn,seconds=180):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            value=fn()
            if value:return value
            time.sleep(.05)
        raise RuntimeError('Timed out waiting for private fixture. Check its simulation.log.')
    results=[]
    try:
        cases=m.available_cases()
        for name in ['sod','kidder']:
            c=next(c for c in cases if c['id']==name)
            assert c['dimension']==1 and c['available'],c
            row=m.launch(dict(preset=name,scheme='CRKSPH',nx=32,duration=.01,steps=5 if name=='sod' else None,record=name=='kidder',exportInterval=.0005,measurements=True,paused=True,**({'configuration':{'params':{'tauFraction':.8}}} if name=='kidder' else {})))
            key=row['id']
            def ready():
                assert m.runs[key].get('status')!='failed',m.public(m.runs[key])
                return m.runs[key].get('registered') and m.runs[key].get('status')=='paused'
            wait(ready)
            assert m.runs[key]['time']==0,m.runs[key]
            m.attach(key,'1234567890abcdef1234567890abcdef')
            wait(lambda:m.runs[key].get('snapshot'))
            info=m.runs[key]['metadata'];assert info['dimension']==1
            if name=='kidder': assert len(info['physicalBounds'])==2
            # Plain live preview ACK does not release a launch-paused run.
            json.load(call(f'/v1/runs/{key}/ack',dict(sequence=m.runs[key]['sequence'])))
            m.pause(key,False)
            wait(lambda:m.runs[key]['status'] in ('completed','failed','stopped'))
            assert m.runs[key]['status']=='completed',m.public(m.runs[key])
            wait(lambda:m.runs[key].get('process').poll() is not None)
            assert m.library.samples(key)['samples']
            if name=='kidder':
                header=json.loads(m.history(key,'metadata')[0]);assert header['dimension']==1
                assert m.runs[key]['time']>.02
                assert any(s.get('performance',{}).get('stepMs',0)>0 for s in m.library.samples(key)['samples'])
            results.append(m.public(m.runs[key]))
        restarted=Manager(m.root,python=args.python,origins=['http://127.0.0.1:5175'])
        assert all(restarted.runs[row['id']]['status']=='completed' for row in results)
        assert all(restarted.library.samples(row['id'])['samples'] for row in results)
        (args.output/'results.json').write_text(json.dumps(results,indent=2))
        print(json.dumps(dict(success=True,runs=[r['id'] for r in results]),indent=2),flush=True)
        if args.browser:
            m=restarted
            server.RequestHandlerClass=partial(Handler,manager=m)
            (m.root/'daemon.json').write_text(json.dumps(dict(endpoint=endpoint,producerToken=m.producer_token,maxSnapshotBytes=m.max_snapshot_bytes)))
            (m.root/'daemon.json').chmod(0o600)
            print(f'Private fixture endpoint: {endpoint}\nPrivate fixture token: {m.token}',flush=True)
            while True:time.sleep(1)
    finally:
        m.shutdown();server.shutdown();server.server_close();thread.join()

if __name__=='__main__':main()
