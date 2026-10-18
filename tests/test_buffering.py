"""The integrator owns no network/encoding work and snapshots never alias its arrays."""
import json
import threading
import time
from types import SimpleNamespace as NS
import numpy as np
import pytest
from test_companion import api, arrays, wait_for
from warpsph_remote.publisher import SimulationPublisher, SimulationStopped
from warpsph_remote.protocol import validate_packet


def publisher_for(m, endpoint):
    (m.root/'daemon.json').write_text(json.dumps(dict(endpoint=endpoint,producerToken=m.producer_token)))
    (m.root/'daemon.json').chmod(0o600)
    return SimulationPublisher('independent transport',runtime=m.root,autostart=False,interval=.01)


def test_slow_transfer_does_not_hold_integrator_or_alias_state_and_controls_remain_live(api, monkeypatch):
    m, call, endpoint = api
    p = publisher_for(m, endpoint)
    release, sending, stopped = threading.Event(), threading.Event(), threading.Event()
    original = p._request
    def slow_request(path, data, headers=None):
        if path.endswith('/snapshot'):
            sending.set()
            if not release.wait(6):raise OSError('fixture gate timeout')
        return original(path,data,headers)
    monkeypatch.setattr(p,'_request',slow_request)
    values=arrays()
    original_positions=values['positions'].copy()
    ctx=NS(spec=NS(store=False),scratch={},scheme='test',config=NS(dt=.001,
        domain=NS(min=np.zeros(2),max=np.ones(2),periodic=np.ones(2,dtype=bool))))
    progress=[]
    def simulate():
        try:
            for step in range(10000):
                values['positions'][:]=step
                p.post_step(ctx,NS(t=step*.001,state=NS(**values)),step)
                progress.append(step)
                time.sleep(.005)
        except SimulationStopped:stopped.set()
    worker=threading.Thread(target=simulate,daemon=True)
    try:
        m.attach(p.id,'viewer-aaaaaaaaaaaa')
        wait_for(lambda:p.wants_snapshot)
        assert p.snapshot(values,step=0,time_value=0)
        assert sending.wait(3)
        worker.start()
        start=time.monotonic()
        time.sleep(1.6)
        assert len(progress)>100  # Many steps while the transfer is still blocked.
        assert m.runs[p.id]['snapshot'] is None
        assert m.runs[p.id]['step']>50  # Status/controls use a separate I/O thread.
        m.pause(p.id,True)
        wait_for(lambda:m.runs[p.id]['status']=='paused')
        assert not release.is_set()
        paused=len(progress)
        time.sleep(.05)
        assert len(progress)==paused
        m.pause(p.id,False)
        wait_for(lambda:len(progress)>paused)
        release.set()
        wait_for(lambda:m.runs[p.id]['snapshot'] is not None)
        packet=m.runs[p.id]['snapshot']; header=validate_packet(packet)
        base=8+(int.from_bytes(packet[4:8],'little')+7)//8*8
        spec=header['arrays']['positions']
        recorded=np.frombuffer(packet,dtype='<f4',offset=base+spec['offset'],count=4).reshape(2,2)
        np.testing.assert_array_equal(recorded,original_positions)
        assert m.runs[p.id]['sequence']==1
        assert not p.wants_snapshot  # One immutable buffer, no backlog while awaiting ACK.
        wait_for(lambda:m.runs[p.id].get('performance',{}).get('publishMs',0)>1000)
        assert m.runs[p.id]['performance']['captureMs']<500
        m.stop(p.id)
        assert stopped.wait(3)
    finally:
        release.set();p.stopping.set()
        if worker.ident:worker.join(3)
        p.close('stopped')


def test_stream_pause_cancels_new_captures_not_simulation_and_survives_heartbeat(api):
    m, call, _=api
    key=m.register(dict(name='test'))
    viewer='viewer-aaaaaaaaaaaa';headers={'X-Viewer-Id':viewer}
    m.attach(key,viewer)
    old=m.runs[key]['captureGeneration']
    call(f'/v1/runs/{key}/stream',dict(paused=True,interval=2),headers=headers).close()
    assert m.runs[key]['captureGeneration']>old
    assert not m.status(key,{})['capture'] and not m.runs[key]['pause']
    m.attach(key,viewer)  # Lease renewal must not resume capture.
    assert not m.status(key,{})['capture']
    assert m.status(key,{})['captureInterval']==2
    call(f'/v1/runs/{key}/stream',dict(paused=False,interval=0),headers=headers).close()
    assert m.status(key,{})['capture'] and not m.runs[key]['pause']
    with pytest.raises(Exception):
        call(f'/v1/runs/{key}/stream',dict(paused=True),headers={'X-Viewer-Id':'viewer-bbbbbbbbbbbb'})
    assert not m.runs[key]['streamPaused']
    for bad in (dict(paused=1),dict(interval=-1),dict(interval=float('nan'))):
        with pytest.raises(ValueError):m.streaming(key,viewer,bad)


@pytest.mark.parametrize('permanent', [True, False])
def test_configuration_upload_failure_does_not_starve_frames_or_busy_retry(api, monkeypatch, permanent):
    from urllib.error import HTTPError
    m,call,endpoint=api
    p=publisher_for(m,endpoint)
    original=p._request
    attempts=[]
    def reject_configuration(path,data,headers=None):
        if path.endswith('/configuration'):
            attempts.append(time.monotonic())
            if permanent: raise HTTPError(endpoint+path,400,'Request body exceeds its limit',{},None)
            raise OSError('Temporary configuration transport failure')
        return original(path,data,headers)
    monkeypatch.setattr(p,'_request',reject_configuration)
    try:
        m.attach(p.id,'viewer-aaaaaaaaaaaa')
        with p.lock:
            p.configuration_pending={'oversized':'fixture'}
        p.transfer_event.set()
        wait_for(lambda:len(attempts)==1)
        wait_for(lambda:p.wants_snapshot)
        assert p.snapshot(arrays(),step=0,time_value=0)
        wait_for(lambda:m.runs[p.id]['sequence']==1)
        wait_for(lambda:'Configuration inspection unavailable' in m.runs[p.id].get('message',''))
        time.sleep(.2)
        assert len(attempts)==1
        assert p.transfer_thread.is_alive()
        if permanent: assert p.configuration_pending is None
        else:
            assert p.configuration_pending is not None
            monkeypatch.setattr(p,'_request',original)
            wait_for(lambda:m.runs[p.id].get('configuration'))
            wait_for(lambda:not m.runs[p.id].get('message'))
    finally:p.close('stopped')
