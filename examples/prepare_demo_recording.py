"""Copy a finished stacked demo, select export cadence, preserve original coordinates.

Preserves the raw input. Reads and writes one frame at a time; output must be new.
"""
from __future__ import annotations
import argparse
from pathlib import Path


def prepare(source: Path, output: Path, interval: float, compression: int = 1,
            static_constants: bool = False):
    import h5py
    import numpy as np
    if interval <= 0:
        raise ValueError('Interval must be positive')
    with h5py.File(source, 'r') as src:
        if not src.attrs.get('completed', False):
            raise ValueError('Input was not marked completed; inspect the solver result first')
        times = src['time'][:]
        if len(times) == 0 or not np.isfinite(times).all() or not (np.diff(times) > 0).all():
            raise ValueError('Expected finite, strictly increasing recorded timestamps')
        selected, target = [0], interval
        for i, t in enumerate(times[1:], 1):
            if t + 1e-10 >= target:
                selected.append(i)
                target = (int((t + 1e-10) / interval) + 1) * interval
        if selected[-1] != len(times)-1:
            selected.append(len(times)-1)
        output.parent.mkdir(parents=True, exist_ok=True)
        with h5py.File(output, 'x') as dst:
            dst.attrs.update(dict(src.attrs))
            dst.attrs.update(sourceFile=source.name, selectedExportInterval=interval)
            src.copy('particles', dst)
            if 'domain' in src:
                src.copy('domain', dst)
            dst.create_dataset('time', data=times[selected])
            for group in ('frames', 'diagnostics'):
                out_group = dst.create_group(group)
                for name, ds in src[group].items():
                    if group == 'frames' and static_constants:
                        first = ds[selected[0]]
                        if all(np.array_equal(first, ds[i]) for i in selected[1:]):
                            if not np.isfinite(first).all():
                                raise ValueError(f'Nonfinite static {name}')
                            dst['particles'].create_dataset(name, data=first,
                                compression='gzip', compression_opts=compression, shuffle=True)
                            continue
                    shape = (len(selected), *ds.shape[1:])
                    chunks = (1, min(ds.shape[1], 8192), *ds.shape[2:]) if len(shape)>1 else True
                    target_ds = out_group.create_dataset(name, shape, dtype=ds.dtype, chunks=chunks,
                                                         compression='gzip', compression_opts=compression, shuffle=True)
                    for j,i in enumerate(selected):
                        values = ds[i]
                        if not np.isfinite(values).all():
                            raise ValueError(f'Nonfinite {name} at frame {i}')
                        target_ds[j] = values
            n = dst['frames/positions'].shape[1]
            info = dict(file=str(output), frames=len(selected), particles=n,
                        firstTime=float(times[0]), finalTime=float(times[-1]))
    info["bytes"] = output.stat().st_size
    return info


def main():
    import json
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--interval', type=float, default=0.025)
    p.add_argument('--compression', type=int, choices=range(1, 10), default=1)
    p.add_argument('--static-constants', action='store_true', help='store exactly constant sampled arrays once')
    a=p.parse_args()
    print(json.dumps(prepare(a.source,a.output,a.interval,a.compression,a.static_constants)))


if __name__=='__main__':
    main()
