# Evidence storage

Written findings, known limitations, and regeneration instructions belong here.
Generated screenshots, profiles, measurements, logs, and built bundles do not
belong in Git. The user explicitly requested two small shipped trajectory assets
in `web/public/demos/`; those catalogue entries are the product-data exception.
Their source runs and intermediate recordings still remain outside Git. See
[provenance and regeneration](RECORDED_DEMOS.md). Use `../warpSPHDevelopment/remote/<distinct-run>/`, or
`$WARPSPH_DEVELOPMENT_ROOT/remote/<distinct-run>/`. Disposable checks can use `/tmp`.

The initial browser verification used
`/home/lu26029/dev/warpSPHDevelopment/remote/trajectory-viewer-20261017-initial/`. These files are development evidence managed separately from source and are not a repository dependency.

## Reproduce without a simulator

From a source checkout with Node.js 22.12+:

```bash
npm ci
npm run build
npm test
npm run dev
```

Open the URL printed by Vite. Select a local HDF5 file or NPZ snapshots in the browser. The labelled analytical 2D/3D
sources require no recordings. For larger deterministic input, select a new
output path (the generator refuses to overwrite a file):

```bash
python examples/make_test_trajectory.py \
  --output /tmp/warpSPHDevelopment/remote/new-run/analytical-100k.h5 \
  --count 100000 --frames 4 --dim 3
# Open this file with the browser's local picker.
```

To use real data, pass an existing native `trajectory.h5`, a run folder containing
it, or a plotting verification snapshots directory. No simulator execution is
needed. Inputs are opened read-only. The plotting archive is managed separately;
see its own regeneration instructions if those recordings are absent.

Colormap source tables are reproducible using
`python examples/generate_colormaps.py` with Matplotlib installed. Those bundled
lookup tables are application source assets, not development measurements.

## Generate optional real solver demos

Use a Python environment in which warpSPH and CUDA already work. This is a
recording utility, not a web-app dependency. The output directory must not exist:

```bash
/path/to/warp/python examples/generate_solver_demos.py --case khh \
  --output /path/to/warpSPHDevelopment/remote/new-run/khh-crksph-256
/path/to/warp/python examples/generate_solver_demos.py --case sloshing \
  --output /path/to/warpSPHDevelopment/remote/new-run/sloshing-200
```

Defaults: KHH nx=256 with CRKSPH through t=4, sloshing nx=200 through t=7;
0.025 simulated seconds between captures. The recorder wraps case hooks without
modifying the solver, writes gzip/shuffle chunks with fixed identity stored once,
and includes scalar pressure in solver units, dynamic support and precomputed
fluid diagnostics. Captures use actual step timestamps; the first is after the
first step and the final available state is included. The solver's own stopping
semantics can finish just short of tLimit. No interpolation or resampling is used.

`summary.json`, `caseSpec.json`, and per-step `diagnostics.json` document each run.
A divergence or stop reason fails the command and must be inspected before using
the recording. These are visualization demos, not new physical validation.

For a smaller export at a chosen cadence, copy selected **unmodified** captured
states with `prepare_demo_recording.py`; the input remains untouched and domain
metadata is retained. This also removes captures that straddle an export threshold
due to floating-point rounding. No coordinate transform or temporal interpolation
is applied:

```bash
python examples/prepare_demo_recording.py /path/to/raw/trajectory.h5 \
  /path/to/warpSPHDevelopment/remote/new-run/demo.h5 --interval 0.025
```

This finalization needs only NumPy and h5py. Periodic coordinate mapping belongs
to the visualizer; recordings intentionally keep unwrapped positions.
