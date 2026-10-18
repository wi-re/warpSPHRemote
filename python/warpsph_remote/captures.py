"""Owned CPU snapshots: capture at a safe boundary, encode on the transfer worker."""
from dataclasses import dataclass
import hashlib
import json
import math
import struct
import numpy as np
from .protocol import encode_frame


@dataclass(frozen=True)
class Capture:
    arrays: dict
    step: int
    time: float
    domain: object
    generation: int
    epoch: int
    expected_revision: str | None
    copy_ms: float
    cpu_bytes: int
    details: dict | None = None


def owned_arrays(arrays, budget):
    values = {k:v for k,v in arrays.items() if v is not None}
    required = {'positions','UIDs','kinds','masses','densities','supports','velocities'}
    if not required <= values.keys():
        raise ValueError('Live snapshots require positions, stable IDs, kinds, masses, density, supports and velocity.')
    values = {k:v if hasattr(v,'shape') else np.asarray(v) for k,v in values.items()}
    shape = values['positions'].shape
    if len(shape)!=2 or shape[1] not in (2,3) or shape[0]<1:
        raise ValueError('Live snapshots require nonempty 2D/3D positions.')
    payload = 0
    for name, value in values.items():
        if len(value.shape) not in (1,2) or value.shape[0]!=shape[0]:
            raise ValueError(f'Invalid live field {name}.')
        if hasattr(value,'element_size'):
            width = value.element_size()
            floating = value.dtype.is_floating_point
        else:
            width = value.dtype.itemsize
            floating = value.dtype.kind == 'f'
        payload += math.prod(value.shape) * (4 if floating or width<=4 else 8)
    if payload > budget:
        raise ValueError(f'Snapshot payload needs {payload / 2**20:.1f} MiB; daemon budget is {budget / 2**20:g} MiB. Increase --max-snapshot-mib on the daemon.')
    result = {}
    for name, value in values.items():
        if hasattr(value,'detach'):
            value = value.detach().cpu().numpy()
        # Never hand a view of mutable simulator storage to another thread.
        result[name] = np.array(value, copy=True, order='C')
        result[name].flags.writeable = False
    return result


def encode_capture(capture, name, budget):
    arrays = capture.arrays
    for field, a in arrays.items():
        if not np.isfinite(a).all():
            raise ValueError(f'Invalid live field {field}.')
    static = {k:arrays[k] for k in ('UIDs','kinds','masses')}
    dynamic = {k:v for k,v in arrays.items() if k not in static}
    digest = hashlib.sha256()
    for key, a in static.items():
        digest.update(key.encode()); digest.update(str((a.dtype.str,a.shape)).encode()); digest.update(a.tobytes())
    revision = digest.hexdigest()
    statics = encode_frame(static,index=capture.step,time=capture.time) if capture.expected_revision!=revision else b''
    dynamics = encode_frame(dynamic,index=capture.step,time=capture.time)
    p = arrays['positions']
    metadata = dict(name=name,dimension=p.shape[1],fields=[dict(name=k,components=a.shape[1] if a.ndim==2 else 1,dtype=a.dtype.str) for k,a in arrays.items()],
        bounds=[p.min(axis=0).tolist(),p.max(axis=0).tolist()],identity='UIDs',domain=capture.domain,
        internalEnergyAvailable='internalEnergies' in arrays,step=capture.step,time=capture.time, **(capture.details or {}))
    packet = struct.pack('<II',len(statics),len(dynamics)) + statics + dynamics
    if len(packet)>budget:
        raise ValueError('Snapshot including headers exceeds the daemon budget; increase --max-snapshot-mib.')
    headers = {'X-Capture-Generation':str(capture.generation),'X-Static-Revision':revision,
        'X-Snapshot-Metadata':json.dumps(metadata,separators=(',',':'),allow_nan=False)}
    return packet, headers, (capture.step,capture.time,revision)
