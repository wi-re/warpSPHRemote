import json
import threading
import time
from types import SimpleNamespace as NS
import numpy as np
import pytest
from test_companion import api,arrays,wait_for
from test_video_capture import setup,ack
from warpsph_remote.cadence import recording_estimate
from warpsph_remote.catalogue import validate_video,validate_launch
from warpsph_remote.telemetry import validate_telemetry


def test_step_video_waits_at_exact_steps_with_variable_dt_and_final_off_cadence(api):
    m,call,p,ctx,values,viewer=setup(api);done=threading.Event();seen=[]
    times=[0,.1,.1001,.1002,.5,.51,.9,.90001]
    def run():
        for step,t in enumerate(times):
            p.post_step(ctx,NS(t=t,state=NS(**values)),step);seen.append(step)
        p.finish(ctx,NS(t=times[-1],state=NS(**values)),len(times)-1)
        done.set()
    try:
        m.video_capture(p.id,viewer,dict(active=True,everySteps=3))
        wait_for(lambda:(p.video or {}).get('everySteps')==3)
        threading.Thread(target=run,daemon=True).start()
        for seq,step in enumerate([0,3,6,7],start=1):
            wait_for(lambda:m.runs[p.id]['sequence']==seq)
            assert m.runs[p.id]['metadata']['step']==step
            assert m.runs[p.id]['metadata']['time']==times[step]
            wait_for(lambda:m.runs[p.id].get('pipeline',{}).get('solver')=='video_frame')
            assert m.public(m.runs[p.id])['frameBuffer']['ready']
            time.sleep(.03);assert not done.is_set()
            ack(call,p,viewer,seq)
        assert done.wait(3)
    finally:p.stopping.set();p.close('stopped')


def test_storage_estimate_uses_actual_fields_and_exact_step_stride_without_copying():
    values=arrays();values['pressures']=np.zeros(2,dtype=np.float32)
    ctx=NS(spec=NS(store=True,exportInterval=.02,nSteps=100),config=NS(dt=.001),scratch={},case=NS(extraFields=('pressures',)))
    state=NS(t=0,state=NS(**values))
    estimate=recording_estimate(ctx,state,0)
    assert estimate['everySteps']==20 and estimate['frames']==6 and not estimate['estimated']
    assert estimate['bytesPerFrame']>=sum(values[k].nbytes for k in ('positions','velocities','densities','pressures'))
    ctx.config.dt=.01
    assert recording_estimate(ctx,state,0)['everySteps']==20 # Solver's initialized export stride is fixed.
    ctx.spec.nSteps=None;ctx.spec.tLimit=1
    assert recording_estimate(ctx,state,0)['estimated']
    validate_telemetry({'storageEstimate':estimate})


def test_step_cadences_validate_and_pipeline_metadata_is_bounded():
    assert validate_video({'everySteps':4})['everySteps']==4
    for bad in (0,-1,1.2,True,10**10):
        with pytest.raises(ValueError):validate_video({'everySteps':bad})
        with pytest.raises(ValueError):validate_launch({'preset':'khh','exportEverySteps':bad})
    for bad in ({'solver':'arbitrary','solverSeconds':0,'capture':'idle'}, {'solver':'running','solverSeconds':float('nan'),'capture':'idle'}):
        with pytest.raises(ValueError):validate_telemetry({'pipeline':bad})


def test_bind_case_exposes_completed_step_count_and_initial_zero(api):
    from dataclasses import dataclass
    m,call,p,ctx,values,viewer=setup(api)
    @dataclass
    class Case:
        postStep: object=None
        extraData: object=None
    try:
        bound=p.bind_case(Case())
        bound.postStep(ctx,NS(t=.01,state=NS(**values)),0)
        assert p.meta['step']==1
    finally:p.close('stopped')
