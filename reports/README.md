# Evidence storage

Written findings, known limitations, and regeneration instructions belong here.
Generated recordings, screenshots, profiles, measurements, logs, and built bundles
do not belong in Git. Use `../warpSPHDevelopment/remote/<distinct-run>/`, or
`$WARPSPH_DEVELOPMENT_ROOT/remote/<distinct-run>/`. Disposable checks can use `/tmp`.

The initial browser verification used
`/home/lu26029/dev/warpSPHDevelopment/remote/trajectory-viewer-20261017-initial/`. These files are development evidence managed separately from source and are not a repository dependency.

## Reproduce without a simulator

From an installed source checkout:

```bash
npm ci
npm run build
pytest -q
npm test
warpsph-remote
```

Open the loopback URL printed by the service. The labelled analytical 2D/3D
sources require no recordings. For larger deterministic input, select a new
output path (the generator refuses to overwrite a file):

```bash
python examples/make_test_trajectory.py \
  --output /tmp/warpSPHDevelopment/remote/new-run/analytical-100k.h5 \
  --count 100000 --frames 4 --dim 3
warpsph-remote /tmp/warpSPHDevelopment/remote/new-run/analytical-100k.h5
```

To use real data, pass an existing native `trajectory.h5`, a run folder containing
it, or a plotting verification snapshots directory. No simulator execution is
needed. Inputs are opened read-only. The plotting archive is managed separately;
see its own regeneration instructions if those recordings are absent.

Colormap source tables are reproducible using
`python examples/generate_colormaps.py` with Matplotlib installed. Those bundled
lookup tables are application source assets, not development measurements.
