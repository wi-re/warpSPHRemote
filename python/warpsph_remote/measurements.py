"""Small reductions only: no full particle-state CPU copies for diagnostic logging."""
import math
import numpy as np

def physical_sample(state,step,time_value):
    def scalar(value):
        value=float(value.item() if hasattr(value,'item') else value)
        return value if math.isfinite(value) else None
    mask=state.kinds==0
    def values(name):
        a=getattr(state,name,None)
        if a is None: return None
        values=a[mask]
        return values if name=='velocities' else values.reshape(-1)
    m,v,rho,p,u=(values(n) for n in ('masses','velocities','densities','pressures','internalEnergies'))
    out=dict(step=step,time=time_value)
    if rho is not None and len(rho): out['meanDensity']=scalar(rho.mean())
    if p is not None and len(p): out['meanPressure']=scalar(p.mean())
    if m is not None and len(m):
        mass=scalar(m.sum())
        if mass is None or not bool((m>=0).all()):
            out.update(totalMass=None,kineticEnergy=None,internalEnergy=None,totalEnergy=None)
            return out
        out['totalMass']=mass
        if v is not None:
            out['kineticEnergy']=scalar((m*(v*v).sum(axis=1)).sum()*.5)
            for c in range(v.shape[1]): out['momentum'+ 'XYZ'[c]]=scalar((m*v[:,c]).sum())
        if u is not None: out['internalEnergy']=scalar((m*u.reshape(-1)).sum())
        if out.get('kineticEnergy') is not None and out.get('internalEnergy') is not None:
            out['totalEnergy']=out['kineticEnergy']+out['internalEnergy']
    return out


def validate_probes(probes):
    if not isinstance(probes,list) or len(probes)>4: raise ValueError('Use up to four probes.')
    seen=set()
    for p in probes:
        if not isinstance(p,dict) or set(p)-{'id','name','position','radius','method'}: raise ValueError('Invalid probe.')
        if not isinstance(p.get('id'),str) or not p['id'] or len(p['id'])>80 or p['id'] in seen: raise ValueError('Invalid probe ID.')
        seen.add(p['id'])
        if not isinstance(p.get('name'),str) or len(p['name'])>100 or p.get('method') not in ('nearest','idw'): raise ValueError('Invalid probe method/name.')
        if not isinstance(p.get('position'),list) or len(p['position']) not in (1,2,3) or any(type(v) not in (int,float) or not math.isfinite(v) for v in p['position']): raise ValueError('Invalid probe coordinates.')
        if type(p.get('radius')) not in (int,float) or not math.isfinite(p['radius']) or p['radius']<=0: raise ValueError('Invalid probe radius.')
    return probes


def probe_samples(state,probes,domain):
    result={}
    for p in probes:
        value=None
        if len(p['position'])==state.positions.shape[1] and getattr(state,'pressures',None) is not None:
            delta=state.positions-state.positions.new_tensor(p['position']) if hasattr(state.positions,'new_tensor') else state.positions-np.asarray(p['position'])
            for c in range(delta.shape[1]):
                if bool(domain.periodic[c]):
                    length=float(domain.max[c]-domain.min[c]);delta[:,c]-=(delta[:,c]/length).round()*length
            dist=(delta*delta).sum(axis=1)
            valid=(state.kinds==0)&(dist<=p['radius']**2)
            if hasattr(dist,'detach'):
                import torch
                valid=valid & torch.isfinite(state.pressures)
                d=dist[valid];pressures=state.pressures[valid]
            else:
                valid=valid & np.isfinite(state.pressures);d=dist[valid];pressures=state.pressures[valid]
            if len(d):
                k=int(d.argmin());near=float(d[k])
                if p['method']=='nearest' or near==0: value=float(pressures[k])
                else:
                    weights=p['radius']**2/d;value=float((weights*pressures).sum()/weights.sum())
        result['probe:'+p['id']]=value if value is not None and math.isfinite(value) else None
    return result
