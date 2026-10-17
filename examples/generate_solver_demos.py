"""Optional demo recorder: requires an installed warpSPH CUDA environment.

The browser viewer and its development server do not import this module.
Recordings go outside the checkout; an existing output directory is refused.
"""
from __future__ import annotations
import argparse
import json
import time
from dataclasses import replace
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--case', choices=['khh', 'sloshing'], required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--duration', type=float)
    p.add_argument('--interval', type=float, default=0.025)
    args = p.parse_args()
    if args.interval <= 0:
        p.error('--interval must be positive')
    args.output.mkdir(parents=True, exist_ok=False)
    from warpSPHBootstrap import bootstrap
    bootstrap(precision='float32')
    import h5py
    import numpy as np
    from warpSPH.runner import run
    if args.case == 'khh':
        from warpSPH.cases.compressible.kelvinHelmholtz import kelvinHelmholtzCase as case
        nx, duration = 256, 4.0
    else:
        from warpSPH.cases.freeSurface.sloshingTank import sloshingTankCase as case
        nx, duration = 200, 7.0
    duration = args.duration if args.duration is not None else duration
    old_step = case.postStep
    output = h5py.File(args.output / 'trajectory.h5', 'w')
    output.attrs.update(format='warpSPHRemote-stacked-v1', case=case.name,
                        pressureUnits='stored solver units', requestedExportInterval=args.interval)
    dyn = output.create_group('frames')
    static = output.create_group('particles')
    diag = output.create_group('diagnostics')
    times = output.create_dataset('time', (0,), maxshape=(None,), dtype='f8', chunks=True)
    next_time = 0.0
    last_progress = 0.0
    count = 0
    last_t = -1.0

    def capture(ctx, state, force=False):
        nonlocal next_time, count, last_t
        t = float(state.t)
        if t <= last_t or (not force and t + 1e-12 < next_time):
            return
        s = state.state
        arrays = {}
        for name in ('positions', 'velocities', 'densities', 'pressures', 'supports'):
            tensor = getattr(s, name, None)
            if tensor is None:
                raise RuntimeError(f'{name} unavailable at t={t}; refusing incomplete recording')
            arrays[name] = tensor.detach().cpu().numpy()
            if not np.isfinite(arrays[name]).all():
                raise RuntimeError(f'Nonfinite {name} at t={t}')
        if getattr(s, 'internalEnergies', None) is not None:
            arrays['internalEnergies']=s.internalEnergies.detach().cpu().numpy()
            if not np.isfinite(arrays['internalEnergies']).all(): raise RuntimeError('Nonfinite internal energy')
        if count == 0:
            domain = output.create_group('domain')
            for name in ('min', 'max', 'periodic'):
                domain.create_dataset(name, data=getattr(ctx.config.domain, name).detach().cpu().numpy())
        for name in ('UIDs', 'kinds', 'masses'):
            data = getattr(s, name).detach().cpu().numpy()
            if count == 0:
                static.create_dataset(name, data=data)
            elif not np.array_equal(static[name][...], data):
                raise RuntimeError(f'{name} changed: this fixed-identity recorder requires a per-frame mapping')
        for name, data in arrays.items():
            if count == 0:
                chunks = (1, min(data.shape[0], 8192), *data.shape[1:])
                dyn.create_dataset(name, (0, *data.shape), maxshape=(None, *data.shape),
                                   dtype=data.dtype, chunks=chunks, compression='gzip',
                                   compression_opts=1, shuffle=True)
            ds = dyn[name]
            ds.resize(count + 1, axis=0)
            ds[count] = data
        fluid = static['kinds'][...] == 0
        v = arrays['velocities'][fluid].astype('f8')
        rows = dict(kineticEnergy=float((0.5 * static['masses'][...][fluid] * (v*v).sum(-1)).sum()),
                    maxSpeed=float(np.linalg.norm(v, axis=-1).max()),
                    meanDensity=float(arrays['densities'][fluid].astype('f8').mean()),
                    particles=int(fluid.sum()))
        if 'internalEnergies' in arrays:
            rows['internalEnergy']=float((static['masses'][...][fluid]*arrays['internalEnergies'][fluid].astype('f8')).sum())
            rows['totalEnergy']=rows['kineticEnergy']+rows['internalEnergy']
        for name, value in rows.items():
            if count == 0:
                diag.create_dataset(name, (0,), maxshape=(None,), chunks=True, dtype='f8')
            ds = diag[name]
            ds.resize(count + 1, axis=0)
            ds[count] = value
        times.resize(count + 1, axis=0)
        times[count] = t
        count += 1
        last_t = t
        next_time = (int((t + 1e-10) / args.interval) + 1) * args.interval
        output.flush()

    def post_step(ctx, state, step):
        nonlocal last_progress
        if old_step:
            old_step(ctx, state, step)
        capture(ctx, state)
        now = time.monotonic()
        if now - last_progress > 20:
            print(json.dumps(dict(case=args.case, step=step, time=float(state.t), frames=count)), flush=True)
            last_progress = now

    try:
        result = run(replace(case, postStep=post_step), nx=nx, tLimit=duration,
                     plot=False, store=False, show=False, holdPlot=False, progress=False,
                     device='cuda', stallDtSteps=500, stallProgress=1e-5)
        capture(result.ctx, result.state, force=True)
        result.ctx.spec.save(str(args.output / 'caseSpec.json'))
        summary = dict(case=case.name, scheme=str(result.ctx.scheme), nx=nx,
                       steps=result.nSteps, frames=count, finalTime=float(result.state.t),
                       requestedDuration=duration, exportInterval=args.interval,
                       wallSeconds=result.wallTime, diverged=result.diverged,
                       stopReason=result.stopReason, velocityAlarms=result.velocityAlarms,
                       pressureUnits='stored solver units', firstFrameIsAfterFirstStep=True)
        output.attrs.update(completed=not result.diverged and result.stopReason is None,
                            steps=result.nSteps, wallSeconds=result.wallTime)
        (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        (args.output / 'diagnostics.json').write_text(json.dumps(result.trajectory) + '\n')
        print(json.dumps(summary), flush=True)
        if result.diverged or result.stopReason:
            raise RuntimeError('Simulation stopped early; see summary.json')
    finally:
        output.close()


if __name__ == '__main__':
    main()
