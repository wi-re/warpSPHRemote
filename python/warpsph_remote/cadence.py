"""Capture scheduling and cheap storage estimates, independent of solver imports."""
import math


def video_due(video, step, time_value, finishing=False):
    if finishing: return True
    if video.get('everySteps') is not None:
        return step >= video.get('nextStep', -1)
    return time_value >= video.get('nextTime', -1)


def recording_estimate(ctx, state, step):
    spec=ctx.spec
    if not getattr(spec,'store',False) or not hasattr(spec,'exportInterval'): return None
    stride=ctx.scratch.get('_remote_export_stride')
    if stride is None:
        stride=max(1,int(spec.exportInterval/float(ctx.config.dt)))
        ctx.scratch['_remote_export_stride']=stride
    fields=('positions','velocities','densities',*getattr(getattr(ctx,'case',None),'extraFields',()))
    per_frame=4
    for name in fields:
        a=getattr(state.state,name,None)
        if a is None: continue
        width=a.element_size() if hasattr(a,'element_size') else a.dtype.itemsize
        per_frame+=math.prod(a.shape)*width
    # Datasets/attributes plus initial/static arrays. No array values are read.
    per_frame+=4096*len(fields)
    n=int(state.state.positions.shape[0]);d=int(state.state.positions.shape[1])
    initial=n*(d*16+64)+65536
    target=getattr(spec,'nSteps',None)
    estimated=target is None
    if target is None:
        dt=float(ctx.config.dt)
        end=getattr(spec,'tLimit',None)
        target=step+math.ceil(max(0,float(end)-float(state.t))/dt) if dt>0 and end is not None else None
    frames=math.ceil(max(0,target-1)/stride)+1 if target is not None else None
    return dict(everySteps=stride,bytesPerFrame=per_frame,initialBytes=initial,
                estimated=estimated,**(dict(frames=frames,totalBytes=initial+frames*per_frame) if frames else {}))
