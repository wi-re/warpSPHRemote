import json
import struct
from pathlib import Path
import threading
from urllib.request import urlopen, Request
from urllib.error import HTTPError

import h5py
import numpy as np
import pytest

from warpsph_remote.sources import open_source, DemoSource
from warpsph_remote.protocol import encode_frame
from warpsph_remote.server import Application, create_server


def write_hdf(path, *, changing_count=False):
    with h5py.File(path, 'w') as h:
        h['combinedKinds'] = [0, 0, 1]
        h['combinedUIDs'] = np.array([2**54+1, 9, 10], dtype=np.int64)
        h['combinedMasses'] = [2., 3., 100.]
        h['combinedSupports'] = [.1, .1, .1]
        h['combinedDensities'] = [999., 999., 999.]
        for key, t, n in [('frame_2', .2, 3), ('frame_10', .7, 2 if changing_count else 3)]:
            h[f'positions/{key}'] = np.zeros((n, 2))
            h[f'velocities/{key}'] = np.array([[3., 4.], [0., 2.], [100., 100.]])[:n]
            h[f'densities/{key}'] = np.array([1., 2., 50.])[:n]
            h[f'times/{key}'] = [t]


def test_hdf_times_identity_dynamic_values_and_fluid_reductions(tmp_path):
    p=tmp_path/'trajectory.h5';write_hdf(p)
    s=open_source(p)
    assert s.times == [.2, .7]  # numeric, not lexicographic order
    assert s.read(1)['UIDs'][0] == 2**54+1
    assert s.read(1)['densities'][0] == 1
    assert s.diagnostic(1) == dict(index=1,time=.7,particles=2,kineticEnergy=31.,internalEnergy=None,totalEnergy=None,maxSpeed=5.,meanDensity=1.5)


def test_changed_population_cannot_reuse_initial_metadata(tmp_path):
    p=tmp_path/'trajectory.h5';write_hdf(p,changing_count=True)
    s=open_source(p)
    with pytest.raises(ValueError, match='Particle count changed'):
        s.read(1)


def test_missing_dynamic_density_does_not_use_initial_density(tmp_path):
    p=tmp_path/'trajectory.h5';write_hdf(p)
    with h5py.File(p,'a') as h: del h['densities']
    s=open_source(p)
    assert 'densities' not in s.read(0)
    assert s.diagnostic(0)['meanDensity'] is None


def test_npz_timestamps_from_recording_and_no_invented_ids(tmp_path):
    snapshots=tmp_path/'snapshots';snapshots.mkdir()
    for step in [10, 2]:
        np.savez(snapshots/f'state_{step}.npz',positions=np.ones((4,2)),velocities=np.ones((4,2)),masses=np.ones(4))
    (tmp_path/'measurements.json').write_text(json.dumps({'frames':[{'step':2,'time':.25},{'step':10,'time':.8}]}))
    s=open_source(snapshots)
    assert s.times == [.25, .8]
    assert s.identity == 'unavailable'
    assert s.diagnostic(0)['kineticEnergy'] == 4


def test_npz_missing_time_is_explicit_frame_axis(tmp_path):
    np.savez(tmp_path/'state_0.npz',positions=np.ones((2,2)))
    s=open_source(tmp_path)
    assert s.time_kind == 'frame'
    assert s.diagnostic(0)['kineticEnergy'] is None


def test_invalid_positions_fail_explicitly(tmp_path):
    np.savez(tmp_path/'state.npz',positions=np.array([[np.nan, 0.]]))
    with pytest.raises(ValueError,match='nonfinite positions'): open_source(tmp_path)


def test_state_layout_and_scalar_metadata(tmp_path):
    p=tmp_path/'states.h5'
    with h5py.File(p,'w') as h:
        for i in range(2):
            g=h.create_group(f'states/frame_{i}/state')
            g['positions']=np.zeros((2+i,3));g['kinds']=np.zeros(2+i,dtype='i4')
            g['UIDs']=np.arange(2+i);g.attrs['time']=i*.3;g.attrs['UIDcounter']=2+i
    s=open_source(p)
    assert s.dim == 3 and s.times == [0,.3]
    assert s.read(1)['positions'].shape == (3,3)


def test_binary_alignment_and_exact_large_ids():
    packet=encode_frame({'positions':np.arange(6,dtype='f8').reshape(3,2),'kinds':np.zeros(3,dtype='i4'),'UIDs':np.array([2**54+1,2,3],dtype='i8')},index=7,time=.2)
    assert packet[:4] == b'WPR1'
    length=struct.unpack('<I',packet[4:8])[0]
    header=json.loads(packet[8:8+length]);base=8+((length+7)//8)*8
    for spec in header['arrays'].values():
        assert (base+spec['offset'])%8 == 0
    ids=header['arrays']['UIDs']
    assert np.frombuffer(packet, dtype='<i8',count=3,offset=base+ids['offset'])[0] == 2**54+1
    assert header['arrays']['positions']['dtype'] == '<f4'


def test_local_api_roundtrip_and_origin_restriction(tmp_path):
    app=Application(web_root=tmp_path)
    (tmp_path/'index.html').write_text('<h1>local viewer</h1>')
    server=create_server(app,0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base=f'http://127.0.0.1:{server.server_port}'
    try:
        with urlopen(base+'/api/sources') as r: sources=json.load(r)
        assert sources[0]['id']=='demo-2d'
        with urlopen(base+'/api/sources/demo-3d/frames/1?field=velocities') as r: assert r.read(4)==b'WPR1'
        with urlopen(base+'/api/sources/demo-2d/diagnostics?count=2') as r: assert len(json.load(r))==2
        with pytest.raises(HTTPError) as exc:
            urlopen(Request(base+'/api/sources',headers={'Origin':'https://other.example'}))
        assert exc.value.code==403
        with pytest.raises(HTTPError) as exc:
            urlopen(Request(base+'/api/sources',data=b'{"path":"/tmp"}',headers={'Content-Type':'application/json'}))
        assert exc.value.code==403
        with pytest.raises(HTTPError) as exc: urlopen(base+'/api/sources/demo-2d/frames/999')
        assert exc.value.code==404
        with urlopen(base) as r: assert b'local viewer' in r.read()
    finally:
        server.shutdown();server.server_close();thread.join()


def test_specific_internal_energy_is_mass_weighted_and_excludes_boundaries(tmp_path):
    np.savez(tmp_path/'energy.npz',positions=np.zeros((3,2)),velocities=np.array([[1,0],[-1,0],[99,99]]),
             kinds=np.array([0,0,1]),masses=np.array([2.,6.,999.]),internalEnergies=np.array([3.,5.,np.nan]))
    s=open_source(tmp_path/'energy.npz')
    d=s.diagnostic(0)
    assert d['internalEnergy']==36.
    assert d['totalEnergy']==40.
    assert s.metadata()['internalEnergyAvailable'] is True
