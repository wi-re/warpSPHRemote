"""Render acknowledgements, disconnect holds and terminal-frame delivery."""
import threading
import time
from types import SimpleNamespace as NS
import numpy as np
import pytest
from test_companion import api, arrays, wait_for
from test_buffering import publisher_for
from warpsph_remote.publisher import SimulationStopped


def setup(api):
    m,call,endpoint=api;p=publisher_for(m,endpoint)
    values=arrays();ctx=NS(spec=NS(store=False),scratch={},scheme='test',config=NS(dt=.01,
        domain=NS(min=np.zeros(2),max=np.ones(2),periodic=np.ones(2,dtype=bool))))
    viewer='viewer-aaaaaaaaaaaa';m.attach(p.id,viewer)
    return m,call,p,ctx,values,viewer


def ack(call,p,viewer,sequence):
    call(f'/v1/runs/{p.id}/ack',dict(sequence=sequence),headers={'X-Viewer-Id':viewer}).close()


def test_video_waits_for_render_ack_skips_to_due_time_and_hands_off_final_frame(api):
    m,call,p,ctx,values,viewer=setup(api);progress=[];done=threading.Event()
    def run():
        try:
            for step in range(8):
                p.post_step(ctx,NS(t=step*.01,state=NS(**values)),step);progress.append(step)
            p.finish(ctx,NS(t=.075,state=NS(**values)),8)
            p.close();done.set()
        except SimulationStopped:pass
    try:
        m.video_capture(p.id,viewer,dict(active=True,interval=.03));wait_for(lambda:(p.video or {}).get('active'))
        worker=threading.Thread(target=run,daemon=True);worker.start()
        wait_for(lambda:m.runs[p.id]['sequence']==1)
        time.sleep(.1);assert progress==[]  # Neither download nor receipt releases the solver.
        assert m.runs[p.id]['metadata']['time']==0
        ack(call,p,viewer,1)
        wait_for(lambda:m.runs[p.id]['sequence']==2)
        assert progress==[0,1,2];assert m.runs[p.id]['metadata']['time']==.03
        ack(call,p,viewer,2)
        wait_for(lambda:m.runs[p.id]['sequence']==3)
        assert m.runs[p.id]['metadata']['time']==.06
        ack(call,p,viewer,3)
        wait_for(lambda:m.runs[p.id]['sequence']==4)
        assert m.runs[p.id]['metadata']['time']==.075
        assert not done.is_set()
        ack(call,p,viewer,4);assert done.wait(4)
        assert m.runs[p.id]['status']=='completed'
    finally:p.stopping.set();p.close('stopped')


@pytest.mark.parametrize('recording',[False,True])
def test_lost_viewer_holds_unrecorded_video_until_explicit_release(api,recording):
    m,call,p,ctx,values,viewer=setup(api);done=threading.Event()
    if recording:m.runs[p.id]['recording']={'path':'/tmp/example.h5','mode':'trajectory'}
    try:
        m.video_capture(p.id,viewer,dict(active=True,interval=.03));wait_for(lambda:(p.video or {}).get('active'))
        worker=threading.Thread(target=lambda:(p.post_step(ctx,NS(t=0,state=NS(**values)),0),done.set()),daemon=True);worker.start()
        wait_for(lambda:m.runs[p.id]['sequence']==1)
        m.runs[p.id]['leaseAt']-=21;m.expire(m.runs[p.id])
        if recording:assert done.wait(3)
        else:
            time.sleep(.15);assert not done.is_set();assert m.runs[p.id]['video']['orphaned']
            m.attach(p.id,'viewer-bbbbbbbbbbbb')
            time.sleep(.1);assert not done.is_set()
            m.video_capture(p.id,'viewer-bbbbbbbbbbbb',dict(active=False))
            assert done.wait(3)
    finally:p.stopping.set();p.close('stopped')


def test_configuration_is_authenticated_read_only_and_video_settings_validate(api):
    m,call,p,ctx,values,viewer=setup(api)
    try:
        p.post_step(ctx,NS(t=0,state=NS(**values)),0)
        wait_for(lambda:m.runs[p.id].get('configuration'))
        import json
        result=json.load(call(f'/v1/runs/{p.id}/configuration'))
        assert result['simulation']['dt']==.01
        for data in ({'active':1},{'active':True,'interval':0},{'active':True,'interval':float('nan')}):
            with pytest.raises(ValueError):m.video_capture(p.id,viewer,data)
    finally:p.close('stopped')


def test_video_requires_capable_adapter_and_terminal_lease_can_finalize(api):
    m,call,_=api
    from warpsph_remote.daemon import Conflict
    key=m.register(dict(name='legacy'))
    viewer='viewer-aaaaaaaaaaaa';m.attach(key,viewer)
    with pytest.raises(Conflict,match='updated adapter'):
        m.video_capture(key,viewer,dict(active=True))
    m.runs[key]['status']='completed'
    # A heartbeat from the existing owner can observe completion even after ACK.
    assert m.attach(key,viewer)['status']=='completed'
    m.video_capture(key,viewer,dict(active=False))
    with pytest.raises(Conflict):m.attach(key,'viewer-bbbbbbbbbbbb')
