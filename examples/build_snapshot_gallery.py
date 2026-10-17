"""Package finished high-resolution solver runs as a small static snapshot gallery.

No simulator import. Copies retained whole states losslessly; output must be new.
"""
import argparse
import hashlib
import json
from pathlib import Path
from prepare_demo_recording import prepare

SPECS = [
    ('tgv-wcsph-512', 'Taylor–Green · 512² snapshots', '262,144-particle WCSPH Taylor–Green vortex; three solver states through t≈1. Initial analytic pressure, viscosity 0.005, target Mach 0.1.', 'tgv', .4),
    ('random-wcsph-256-snapshots', 'Decaying flow · 256² snapshots', '65,536-particle periodic WCSPH random flow, viscosity 0.005. Three states through t≈2.', 'random', .8),
    ('wake-disk-384', 'Disk wake · high-resolution snapshots', 'Developing flow past an analytic disk at nominal Re=100 in a periodic 12×6 box with pinned inflow. WCSPH; four states through t≈12.', 'disk', 5.),
    ('wake-square-384', 'Square wake · high-resolution snapshots', 'Developing flow past an analytic square at nominal Re=100 in a periodic 12×6 box with pinned inflow. WCSPH; a few states through t≈12.', 'square', 5.),
]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('tgv','random','disk','square'):
        parser.add_argument('--'+name,type=Path,required=True,help='completed trajectory.h5')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    entries=[]
    for key,name,description,which,interval in SPECS:
        dest=args.output/(key+'.h5')
        info=prepare(getattr(args,which),dest,interval,9,True)
        entries.append(dict(id='demo-'+key,name=name,description=description,file=dest.name,bytes=dest.stat().st_size,sha256=hashlib.sha256(dest.read_bytes()).hexdigest(),particles=info['particles'],frames=info['frames'],duration=info['finalTime'],group='snapshots'))
    (args.output/'recorded-demos.json').write_text(json.dumps(entries,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps(entries,indent=2,ensure_ascii=False))

if __name__=='__main__':main()
