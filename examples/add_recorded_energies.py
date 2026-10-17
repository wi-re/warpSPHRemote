"""Attach same-run recorded global energies to a new copy of a stacked trajectory.

Requires only NumPy/h5py. Does not infer an equation of state or change particles.
"""
import argparse
import json
import shutil
from pathlib import Path
import h5py
import numpy as np


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('trajectory',type=Path)
    p.add_argument('diagnostics',type=Path)
    p.add_argument('output',type=Path)
    args=p.parse_args()
    rows=json.loads(args.diagnostics.read_text())
    by_time={float(row['t']):row for row in rows}
    with h5py.File(args.trajectory,'r') as src:
        times=src['time'][:]
        energy=np.array([by_time[float(t)]['thermalEnergy'] for t in times],dtype='f8')
        if not np.isfinite(energy).all():raise ValueError('Recorded internal energies contain nonfinite values')
        total=energy+src['diagnostics/kineticEnergy'][:]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('xb') as dst,args.trajectory.open('rb') as src:shutil.copyfileobj(src,dst)
    with h5py.File(args.output,'a') as out:
        out['diagnostics/internalEnergy']=energy
        out['diagnostics/totalEnergy']=total
        out['diagnostics/internalEnergy'].attrs['provenance']='Exact matching timestamps from same-run solver thermalEnergy diagnostics; sum(m*u), fluid only'
        out['diagnostics/totalEnergy'].attrs['definition']='Recorded kineticEnergy plus recorded internalEnergy'
    print(json.dumps(dict(file=str(args.output),frames=len(times),firstInternalEnergy=float(energy[0]),lastInternalEnergy=float(energy[-1]),firstTotalEnergy=float(total[0]),lastTotalEnergy=float(total[-1]))))


if __name__=='__main__':main()
