# warpSPHRemote

A local trajectory studio for SPH simulations. Open an existing recording,
choose a field, and explore it in an independent browser GPU renderer.

The first milestone is **recorded trajectory visualization**. Simulation
integration comes after the rendering and interaction model have been exercised
on real data. No changes to warpSPH, warpSPHCore, or warpSPHPlotting are required.

## Run locally

Requires Python 3.10+ and Node.js 22.12+ (Node 24 recommended).

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
npm ci
npm run build
warpsph-remote /absolute/path/to/trajectory.h5
```

Open **http://127.0.0.1:8765**. Multiple paths can be supplied, or use **Open
trajectory** in the application to enter another local path. The service only
listens on loopback. Files are opened read-only and remain on your computer.
This preview is run from a source checkout; build the web assets before launch.

With no paths, `warpsph-remote` provides explicitly labelled 2D and 3D analytical
Taylor–Green examples. These sample a field on a fixed lattice; they are not
advected particle simulations.

## Supported recordings

- Native warpSPH `trajectory.h5`: `positions/frame_*`, `velocities/frame_*`,
  `densities/frame_*`, `times/frame_*`, optional additional numerical field
  groups, and initial `combinedKinds`, `combinedUIDs`, `combinedMasses`, etc.
- HDF5 state groups: `states/<frame>/positions` or
  `states/<frame>/state/positions`, with time attributes on either frame or state.
- A standalone HDF5 export with `state/positions` (one frame).
- A directory of NPZ snapshots, or one NPZ file, containing `positions` and
  optional `velocities`, `densities`, `masses`, `supports`, `kinds`, and `UIDs`.
  Snapshot `time` / `t` values are used if present. The plotting verification
  archive's sibling `measurements.json` is also understood. If physical time
  was not recorded, the interface explicitly uses **frame index**.

For a native run directory containing `trajectory.h5`, pass the directory.
For NPZ sequences, pass the snapshots directory itself. Frames are ordered
numerically and read on demand, rather than loaded into memory as a trajectory.
Only numerical datasets are read; simulator configuration callables are never
restored. Finished recordings are the supported input; concurrent HDF5 writes
and tailing a running simulation are not implemented.

Legacy HDF5 combined metadata assumes the recording preserves row identity.
Changing particle counts require per-frame metadata; incompatible initial
metadata is rejected. Same-count row reordering cannot be reconstructed if the
recording did not store its changing identity mapping. NPZ inputs without UIDs
are explicitly identified as such; particle selection is confined to one frame.

## Current viewer

- Instanced WebGL2 particle discs in 2D and depth-correct sphere impostors in 3D.
- Pan, zoom, orbit, fit current frame, camera-relative orientation triad,
  particle probes, axis-aligned 3D clipping, and a reference grid/box.
- Scalar fields and vector magnitude / components; seven bundled 256-entry
  colormaps; linear, logarithmic, and symmetric-log normalization.
- Automatic fluid-only ranges or manually fixed ranges; passive gray boundaries
  and ghosts; physical or fixed-pixel particle sizing; dark and light backgrounds.
- Play, pause, step, seek, loop, and playback speed. Each next playback frame
  is requested after the current one has loaded; slow reads slow playback.
- Plotly kinetic-energy, maximum-speed, and mean-density histories. Computation
  runs in bounded batches near the files. The selected frame is prioritized.
- PNG export of the GPU scene. The exported canvas does **not** currently include
  HTML labels, the colorbar, or the diagnostics chart.

Units follow the stored arrays. Kinetic energy is `0.5 * sum(m * |v|²)` over
kind-0 fluid particles, maximum speed is a fluid-only maximum, and mean density
is an unweighted fluid-particle mean. Missing quantities remain unavailable;
missing mass is not replaced with unit mass. Nonfinite values invalidate the
corresponding diagnostic. Invalid or nonpositive log display samples are gray.
A constant field gets a finite color range. Symmetric log uses
`sign(x) * log(1 + abs(x))` (linear transition scale 1 in the field's units).
3D sphere shading intentionally modulates palette brightness to provide depth.

Physical diameter is `0.8 * (mass / density) ** (1 / dimension)`, multiplied by
the particle scale control. Missing physical volume falls back to a fraction
of the recorded support, then an approximate domain spacing. Fixed-pixel mode
uses a 4-pixel diameter at scale 1. Very dense physical particles can be subpixel;
use particle scale or fixed-pixel mode for visibility. The reference box is the
first frame's particle extent, not a reconstructed physical domain. Camera state
is retained through ordinary frame changes; **Fit** fits the current frame.

Keyboard: **Space** play/pause, **← / →** step, **F** fit. In 2D, left drag pans;
in 3D, left drag orbits and right drag pans. Scroll zooms; click probes a particle.
Controls are also available in the in-app help dialog.

## Development

```bash
# Terminal 1: file service
warpsph-remote /absolute/path/to/recording
# Terminal 2: frontend with hot reload (proxies /api to port 8765)
npm run dev

# Numerical/data-contract tests and production build
pytest -q
npm test
npm run build
```

The Python service depends only on NumPy and h5py. The frontend uses React,
TypeScript, Three.js, and Plotly. It has no Torch, Warp, VTK, PyVista, trame,
Jupyter, external font, or CDN runtime requirement. WebGL2 is the implemented
renderer; a WebGPU backend is future work, not a selectable placeholder.

[Architecture and scope](reports/ARCHITECTURE.md),
[verification and known limits](reports/VERIFICATION.md), and
[evidence storage](reports/README.md) describe the current boundary.
