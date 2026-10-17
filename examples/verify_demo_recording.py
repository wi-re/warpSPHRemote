"""Verify selected demo frames exactly match their original unwrapped recording."""
import argparse
import json
from pathlib import Path
import h5py
import numpy as np


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('original',type=Path)
    p.add_argument('prepared',type=Path)
    args=p.parse_args()
    with h5py.File(args.original,'r') as raw,h5py.File(args.prepared,'r') as selected:
        times=raw['time'][:]
        indices=np.searchsorted(times,selected['time'][:])
        assert np.array_equal(times[indices],selected['time'][:]), 'Timestamps were changed'
        for name in ('particles','domain'):
            for field in selected[name]:
                if field in raw[name]:
                    assert np.array_equal(raw[name][field][:],selected[name][field][:]),f'{name}/{field}'
                elif name == 'particles' and field in raw['frames']:
                    for i in indices:
                        assert np.array_equal(raw['frames'][field][i],selected[name][field][:]),f'static {field} at frame {i}'
                else:
                    raise AssertionError(f'Unknown field {name}/{field}')
        for group in ('frames','diagnostics'):
            for j,i in enumerate(indices):
                for field in selected[group]:
                    assert np.array_equal(selected[group][field][j],raw[group][field][i]),f'{group}/{field} frame {j}'
        print(json.dumps(dict(frames=len(indices),allArraysExactlyPreserved=True,bytes=args.prepared.stat().st_size)))


if __name__=='__main__':
    main()
