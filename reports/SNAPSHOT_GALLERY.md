# High-resolution solver snapshot gallery

Generated 2026-10-17 for frame-local interpolation/derivative/statistical analysis.
These are actual deltaSPH/WCSPH solver states, not sampled analytical fields or
invented obstacle trajectories. Only a few whole states are retained. Original
coordinates and all retained numerical arrays are copied exactly; no quantization,
wrapping, particle decimation or fabricated intermediate times are used.

| Asset | Particles | States | Final time | Download bytes |
| --- | ---: | ---: | ---: | ---: |
| tgv-wcsph-512.h5 | 262,144 | 3 | 1.0004043 | 16,661,004 |
| random-wcsph-256-snapshots.h5 | 65,536 | 3 | 2.0 | 3,977,047 |
| wake-disk-384.h5 | 72,916 | 4 | 12.0012197 | 4,052,669 |
| wake-square-384.h5 | 72,704 | 4 | 12.0012197 | 4,084,659 |

All four runs completed without divergence, early stop or velocity alarms.
Existing long recordings and their checksums remain unchanged. Gallery cards are
in **Open trajectory → Example recordings → High-resolution snapshots**, and
include direct HDF5 download links. All examples use the same independently
versioned browser cache. The files work without any Python/Warp installation.

## Solver provenance

Simulator revision: `33d4d94ad4117ed9bc7608c10c62bc151130e6c3`.
Core revision: `8f5dd4449bee4b7591b438f090ec95bb787a3390`.
Precision float32 on the installed CUDA/Warp/PyTorch environment. No simulator
implementation was modified for the gallery.

TGV uses `periodic.tgvWeaklyCompressible.tgvWeaklyCompressibleCase`, 512²,
periodic [0,2π]², deltaSPH, Wendland4, n_h=4, RK2, physical viscosity 0.005,
initial analytic pressure, target Mach 0.1 / reference speed 1. Export every 0.5
through t≈1. 1,475 steps completed in 42.79 s without divergence, early stop or
velocity alarms. Three finite states are retained, including first/last.

Decaying flow uses `periodic.randomFlow.randomFlowCase`, 256², periodic [0,2]²,
seed 20261017, unforced tileable divergence-free Perlin-potential initial velocity,
viscosity 0.005, fixed target dt=0.00025. 8,000 steps to t≈2 completed in 69.80 s
without divergence, early stop or velocity alarms. Three states are saved about
one simulated second apart. See the original recording report for the same
128² case's noise construction and physical interpretation.

Wakes use `boundaries.cylinderWake.cylinderWakeCase`, nx=384 along length 12,
Ly=6, D=U=1, nominal Re=100, body center x=4, pinned-velocity seam band width 0.75,
C0=10, target dt=0.001, Wendland2 n_h=4, RK2 and analytic no-slip bodies. The case's
supported calibrated alpha viscosity is used (alpha≈0.188682). Morris viscosity
has no analytic-wall term in this solver revision; the attempted unsupported
configuration was not published. The case setup uses periodic images and a pinned
inflow frame; these are developing confined wakes, not a validation of mature
unbounded-cylinder shedding or drag statistics. Disk: 12,000 steps in 137.65 s,
no divergence, early stop or velocity alarms. Square uses the BoxRep analytic body: 12,000 steps completed in 1,216.13 s without alarms.

Few snapshots are appropriate for frame-local grids, divergence/curl, LIC and
spatial FFTs. They are intentionally sparse for temporal trajectory/FTLE studies;
do not infer missing temporal scales. Raw solver coordinates are retained even
when outside the periodic display box. Geometry holes appear through fluid
coverage masks; analytic body mesh metadata is not currently rendered separately.

## Regeneration

Use a configured simulator environment (the viewer-only Python environment does
not contain Torch/Warp), with the sibling source packages on PYTHONPATH if not
installed. Choose distinct output folders; the recorder refuses overwrites.

```bash
export WARPSPH_COMPILE_WALLS=1
/path/to/warp/python examples/generate_solver_demos.py --case tgv --nx 512 \
  --duration 1 --interval .5 --viscosity .005 --output /new/run/tgv
/path/to/warp/python examples/generate_solver_demos.py --case random --nx 256 \
  --duration 2 --interval 1 --seed 20261017 --viscosity .005 --output /new/run/random
/path/to/warp/python examples/generate_solver_demos.py --case wake --shape disk \
  --nx 384 --duration 12 --interval 6 --output /new/run/disk
/path/to/warp/python examples/generate_solver_demos.py --case wake --shape square \
  --nx 384 --duration 12 --interval 6 --output /new/run/square
python examples/build_snapshot_gallery.py --tgv /new/run/tgv/trajectory.h5 \
  --random /new/run/random/trajectory.h5 --disk /new/run/disk/trajectory.h5 \
  --square /new/run/square/trajectory.h5 --output /new/gallery
python examples/verify_demo_recording.py /new/run/tgv/trajectory.h5 \
  /new/gallery/tgv-wcsph-512.h5
# Repeat the lossless verifier for each source/output pair.
```

Package uses gzip-9/shuffle and exact static-array deduplication. Add generated
catalogue entries to `web/src/recorded-demos.json` with their computed checksums;
copy only these explicit product assets under `web/public/demos/`. Full raw runs,
case specifications, run diagnostics and logs belong outside Git.

`npm test` checks all assets/checksums and opens first/last high-resolution states,
including finite physical arrays and exact stable identities. Run
`npm run bench:gpu -- --snapshots --derivatives` for first/middle/last states,
128/256/512 grids and both normalized divergence/vorticity. These compare the
viewer reconstruction with its CPU reference; they do not certify simulator
convergence. Timing during the concurrent gallery solver run is not a clean
performance measurement and is not used as a browser FPS claim.

Evidence: `/home/lu26029/dev/warpSPHDevelopment/remote/view-analysis-gallery-20261017/`.
Raw runs, summaries and case specs are preserved there from the distinct
`/tmp/warpsph-gallery-20261017/` development folder. Per-asset SHA256 values are in
the versioned catalogue. The old three curated assets keep their original hashes.

All four assets passed CPU/WebGPU derivative comparisons at 128, 256 and 512 grid resolution on first/middle/last states (24 case/quantity/resolution combinations, nine samples each). The largest scaled error remained below the 3e-4 acceptance threshold; the square wake maximum was 2.63e-6.
