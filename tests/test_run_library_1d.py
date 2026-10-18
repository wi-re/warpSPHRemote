import json
from types import SimpleNamespace as NS
import numpy as np
import h5py
import pytest
from test_companion import api, arrays, wait_for
from warpsph_remote.daemon import Manager
from warpsph_remote.protocol import encode_frame, validate_packet
from warpsph_remote.sources import HDF5Source, NPZSource
from warpsph_remote.captures import Capture, owned_arrays, encode_capture
from warpsph_remote.measurements import physical_sample, probe_samples, validate_probes
from warpsph_remote.publisher import SimulationPublisher
from warpsph_remote.recordings import read_recording


def test_native_1d_file_packet_and_compressing_bounds(tmp_path):
    path=tmp_path/'compression.h5'
    with h5py.File(path,'w') as f:
        for i,t in enumerate([0,.1,.7]):
            key=f'frame_{i}'
            f[f'positions/{key}']=np.array([[.9],[1.]])*(1-t)
            f[f'velocities/{key}']=np.array([[-1.],[-2.]])
            f[f'times/{key}']=t
        f['combinedUIDs']=np.array([2**54+1,8],dtype=np.int64)
        f['frameMetadata/physicalBounds']=np.array([[[.9*(1-t)],[1-t]] for t in [0,.1,.7]])
    source=HDF5Source(path)
    assert source.metadata()['dimension']==1
    assert source.read(2,'velocities')['positions'].shape==(2,1)
    assert source.frame_metadata(2)['physicalBounds'][0][0]==pytest.approx(.27)
    body,_=read_recording(dict(path=str(path),mode='trajectory'), 'frame',2,'velocities')
    header=validate_packet(body)
    assert header['physicalBounds']==source.frame_metadata(2)['physicalBounds']
    assert header['arrays']['positions']['shape']==[2,1]
    assert source.read(0)['UIDs'][0]==2**54+1
    np.savez(tmp_path/'one.npz',positions=np.array([[0.],[1.]]),velocities=np.array([[-2.],[3.]]))
    assert NPZSource(tmp_path/'one.npz').metadata()['dimension']==1


def test_live_1d_owned_capture_keeps_native_shape():
    a=arrays();a['positions']=a['positions'][:,:1];a['velocities']=np.array([[-3.],[2.]])
    raw=owned_arrays(a,2**20)
    capture=Capture(raw,1,.2,None,1,0,None,0,100,dict(physicalBounds=[[.1],[.3]]))
    body,headers,_=encode_capture(capture,'one',2**20)
    assert json.loads(headers['X-Snapshot-Metadata'])['dimension']==1
    assert json.loads(headers['X-Snapshot-Metadata'])['physicalBounds']==[[.1],[.3]]
    assert raw['velocities'][0,0]==-3


def test_finished_runs_config_recording_and_telemetry_survive_restart(api,tmp_path):
    m,call,_=api
    key=m.register(dict(name='finished',pid=1234,measurements=True))
    m.runs[key]['configuration']={'case':'sod','resolved':{'gamma':1.4}}
    m.status(key,dict(step=1,time=.1,dimension=1,performance={'stepMs':12},resources={'sampledAt':1,'processRamBytes':200,'gpus':[]},measurementSamples=[{'step':1,'time':.1,'kineticEnergy':5.,'meanPressure':None}],status='completed'))
    other=Manager(m.root)
    row=other.public(other.runs[key]);assert row['status']=='completed' and not row['registered']
    assert row['configurationAvailable'] and row['measurements']
    samples=other.library.samples(key)['samples']
    assert any(r.get('physical',{}).get('kineticEnergy')==5 for r in samples)
    assert any(r.get('performance',{}).get('stepMs')==12 for r in samples)
    assert any(r.get('resources',{}).get('processRamBytes')==200 for r in samples)
    assert all('token' not in str(r).lower() for r in samples)
    assert json.load(call(f'/v1/runs/{key}/measurements'))['samples']
    assert json.load(call(f'/v1/runs/{key}/storage'))['recordingBytes']==0
    other.library.forget(key)
    assert not Manager(m.root).runs


def test_active_recovery_separate_from_saved_completion(tmp_path):
    m=Manager(tmp_path/'r');key=m.register(dict(name='paused',pid=123));m.status(key,dict(status='paused',step=7,time=.2))
    restarted=Manager(m.root)
    assert restarted.runs[key]['status']=='interrupted'
    assert not restarted.runs[key]['registered']
    restarted.register(dict(name='paused',pid=123,startedAt=m.runs[key]['startedAt'],reconnect=True,paused=True),key)
    restarted.status(key,dict(status='paused',step=7,time=.2))
    assert restarted.runs[key]['status']=='paused'


def test_physical_reductions_and_probe_gap_periodic_signed_velocity():
    state=NS(positions=np.array([[.99],[.3],[.4]]),velocities=np.array([[-2.],[3.],[50.]]),kinds=np.array([0,0,1]),masses=np.array([2.,1.,100]),densities=np.array([1.,2.,100.]),pressures=np.array([8.,4.,100.]),internalEnergies=np.array([3.,4.,90.]))
    result=physical_sample(state,4,.2)
    assert result['momentumX']==-1
    assert result['kineticEnergy']==8.5 and result['totalEnergy']==18.5
    probes=validate_probes([dict(id='p',name='P',position=[.01],radius=.03,method='nearest'),dict(id='dry',name='dry',position=[.7],radius=.01,method='idw')])
    values=probe_samples(state,probes,NS(min=[0],max=[1],periodic=[True]))
    assert values=={'probe:p':8,'probe:dry':None}
    with pytest.raises(ValueError): validate_probes([dict(probes[0],radius=0)])


def test_stacked_1d_domain_frames_and_closed_writer_geometry(tmp_path):
    path=tmp_path/'stacked.h5'
    with h5py.File(path,'w') as f:
        f['frames/positions']=np.array([[[.2],[.6]],[[.1],[.3]]])
        f['frames/velocities']=np.array([[[-1.],[-2.]],[[-2.],[-4.]]])
        f['particles/UIDs']=np.array([2**54+1,9],dtype=np.int64)
        f['time']=np.array([0.,.8])
        f['frameMetadata/domainMin']=np.array([[0.],[0.]])
        f['frameMetadata/domainMax']=np.array([[1.],[.5]])
        f['frameMetadata/periodic']=np.array([[1],[1]])
    s=HDF5Source(path)
    assert s.metadata()['dimension']==1 and s.times==[0,.8]
    assert s.frame_metadata(1)['domain']['max']==[.5]
    assert s.read(1,'velocities')['velocities'][0,0]==-2
    assert s.read(1)['UIDs'][0]==2**54+1
    native=tmp_path/'closed.h5'
    with h5py.File(native,'w') as f:
        f['times/frame_0']=np.array([0.])
        f['times/frame_1']=np.array([.8])
    publisher=SimulationPublisher.__new__(SimulationPublisher)
    publisher._recording=dict(path=str(native),mode='trajectory',physicalModel=dict(kind='kidder',inner=.9,outer=1.,tau=1.))
    publisher._finalize_geometry()
    with h5py.File(native,'r') as f:
        assert np.allclose(f['frameMetadata/physicalBounds'][1,:,0],[.54,.6])


def test_diagnostic_retries_are_idempotent_and_probe_definitions_persist(api):
    m,call,_=api
    key=m.register(dict(name='diagnostics',pid=321,measurements=True))
    sample=dict(step=7,time=.3,wallTime=123.,meanPressure=4.)
    for _ in range(2):m.status(key,dict(measurementSamples=[sample],status='running'))
    rows=m.library.samples(key)['samples']
    assert len([r for r in rows if 'physical' in r])==1
    probes=[dict(id='p',name='wall',position=[.1],radius=.01,method='idw')]
    assert json.load(call(f'/v1/runs/{key}/probes',dict(probes=probes)))['probes']==probes
    assert Manager(m.root).runs[key]['diagnosticProbes']==probes


def test_library_io_failure_does_not_break_simulation_controls(api,monkeypatch):
    import sqlite3
    m,_,_=api
    key=m.register(dict(name='control survives disk error',pid=123,measurements=True))
    def fail(*a,**k): raise sqlite3.OperationalError('disk is full')
    monkeypatch.setattr(m.library,'save',fail)
    m.pause(key,True)
    response=m.status(key,dict(status='running',time=.1,step=1))
    assert response['pause'] and 'disk is full' in m.runs[key]['libraryError']
    m.pause(key,False)
    assert not m.status(key,dict(status='running',time=.2,step=2))['pause']
