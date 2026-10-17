"""Create a deterministic analytical HDF5 recording outside the source checkout.

This is a renderer fixture, not a solver run. Requires only NumPy and h5py.
"""
import argparse
from pathlib import Path
import h5py
import numpy as np


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',required=True,type=Path)
    p.add_argument('--count',type=int,default=100_000)
    p.add_argument('--frames',type=int,default=8)
    p.add_argument('--dim',type=int,choices=[2,3],default=3)
    args=p.parse_args()
    if args.count<1 or args.frames<1: p.error('count and frames must be positive')
    output=args.output.expanduser().resolve()
    root=Path(__file__).resolve().parents[1]
    if output.is_relative_to(root): p.error('Generated recordings must live outside the source checkout.')
    output.parent.mkdir(parents=True,exist_ok=True)
    rng=np.random.default_rng(42)
    points=rng.uniform(0,2*np.pi,(args.count,args.dim)).astype('f4')
    with h5py.File(output,'x') as h:
        h.attrs['description']='Analytical field fixture; fixed sampling points, not solver dynamics.'
        h['combinedUIDs']=np.arange(args.count,dtype='i8')
        h['combinedKinds']=np.zeros(args.count,dtype='i4')
        h['combinedMasses']=np.full(args.count,(2*np.pi)**args.dim/args.count,dtype='f4')
        h['combinedSupports']=np.full(args.count,2*np.pi/args.count**(1/args.dim)*2,dtype='f4')
        for i in range(args.frames):
            t=i*.1;x,y=points[:,0],points[:,1]
            v=np.stack((np.sin(x)*np.cos(y),-np.cos(x)*np.sin(y)),axis=1)*np.exp(-.15*t)
            if args.dim==3: v=np.column_stack((v*np.cos(points[:,2:3]),np.zeros(args.count)))
            h[f'positions/frame_{i:05}']=points
            h[f'velocities/frame_{i:05}']=v.astype('f4')
            h[f'densities/frame_{i:05}']=np.ones(args.count,dtype='f4')
            h[f'times/frame_{i:05}']=[t]
    print(output)

if __name__=='__main__': main()
