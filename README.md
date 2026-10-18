# warpSPHRemote

A local trajectory studio for SPH simulations. Open an existing recording,
choose a field, and explore it in an independent browser GPU renderer.

Recorded-file viewing and optional live simulation monitoring are implemented.
The viewer stays independent of the solver; an optional Linux companion supplies
live snapshots, controls, case launching and opt-in recorded history. Use localhost
or SSH forwarding for the normal connection workflow.

See the [current feature inventory, gaps and next priorities](reports/ROADMAP.md).
This is the consolidated status; individual reports retain their historical
measurements and numerical contracts.

## Open on the web

[Open the visualizer](https://fluids.dev/warpSPHRemote/), choose a local HDF5
recording, or select NPZ snapshots. Data is read on your device; recording contents
are not uploaded. **Remember last recording** retains one browser-local copy
and restores its frame, field, colormap, range, appearance, grid/streamline
settings, diagnostic tab and playback preferences on refresh. Playback resumes paused. You can disable this or
choose **Forget saved recording** in Viewer settings. Reopen the original file
to read later changes; browser quota, private-session and eviction rules apply.
**Open trajectory → Example recordings** offers **Decaying random flow · WCSPH**
(16,384 particles, 61 frames, 15.7 MiB), **Sloshing tank** (71 frames, 7.5 MiB),
and **Kelvin–Helmholtz · CRKSPH** (65,536 particles, 41 frames, 46.7 MiB).
Choose one to download and open it directly; no file exchange or simulator setup
is needed. Each download has its own IndexedDB cache and stays available under
**On this device**, even when another file is selected or last-recording
restoration is disabled. Analytical 2D/3D demos need no download.
See [demo provenance and regeneration](reports/RECORDED_DEMOS.md).

The static app needs no Python, Torch, Warp, Jupyter, or simulator installation.
WebAssembly is required for HDF5; WebGL2 draws the 2D/3D scenes. Native 1D profiles use Canvas 2D.

## Develop locally

Requires Node.js 22.12+ (Node 24 recommended):

```bash
npm ci
npm run dev
```

Open the URL Vite prints and pick a saved recording. A working warpSPH environment
is needed only to **generate new solver trajectories**, not to develop the website.

For a static build:

```bash
npm run build
python -m http.server --directory dist 8765
```

Python's standard-library server is just one way to serve static files. Any static
host works. Do not open `dist/index.html` through `file://`; module workers need
HTTP(S). The GitHub Pages workflow builds and deploys `main` with the host's base
path, supporting both repository subpaths and a custom domain.

### Optional Python file service

For server-side paths or the existing WPR1 API, install Python 3.10+ with NumPy
and h5py. The service is **optional**, loopback-only, and does not need warpSPH:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
npm run build
warpsph-remote /absolute/path/to/trajectory.h5
```

Open `http://127.0.0.1:8765/?service=1` to opt into the same-origin Python API.
The default page always uses the browser file reader. For Vite with the Python
API, use `?service=1` on Vite's URL; `/api` is proxied to port 8765.

## Supported recordings

- Chunked HDF5: `/frames/positions [T,N,D]`, additional numerical frame arrays,
  `/particles/{UIDs,kinds,masses}` and `/time [T]`. See [format guidance](reports/BROWSER_FILES.md).
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

In the browser, select `trajectory.h5` itself, or select NPZ files / their snapshot
folder. An optional `measurements.json` may be included with NPZ snapshots.
In Python service mode a native run directory or NPZ snapshot directory may be passed. Frames are ordered
numerically and read on demand, rather than loaded into memory as a trajectory.
Only numerical datasets are read; simulator configuration callables are never
restored. Direct browser/file-service inputs must be finished recordings.
Live snapshots and safe reading of a running simulation's exported history are
provided separately by the optional companion; arbitrary concurrent HDF5 reading
is not supported.

Legacy HDF5 combined metadata assumes the recording preserves row identity.
Changing particle counts require per-frame metadata; incompatible initial
metadata is rejected. Same-count row reordering cannot be reconstructed if the
recording did not store its changing identity mapping. NPZ inputs without UIDs
are explicitly identified as such; particle selection is confined to one frame.

## Current viewer

- Native 1D quantity-versus-position profiles with signed values, numerical axes,
  fixed/following extents, picking and explicit moving physical-boundary markers.
  Includes a browser-only synthetic contraction demo (`?demo=demo-1d`).
- Instanced WebGL2 particle discs in 2D and depth-correct sphere impostors in 3D.
- Pan, zoom, orbit, fit current frame, camera-relative orientation triad,
  particle inspection, fixed spatial pressure probes, axis-aligned 3D clipping, and a reference grid/box.
- Scalar fields and vector magnitude / components; seven bundled 256-entry
  colormaps; linear, logarithmic, and symmetric-log normalization.
- Automatic fluid-only ranges or manually fixed ranges; passive gray boundaries
  and ghosts; physical or fixed-pixel particle sizing; dark and light backgrounds.
- Play, pause, step, seek, loop, and playback speed. Each next playback frame
  is requested after the current one has loaded; slow reads slow playback.
- Plotly kinetic, internal and total energy, maximum-speed, and mean-density histories. Computation
  runs in bounded worker batches. The selected frame is prioritized. Optional
  stored diagnostics avoid rescanning particle arrays for these three quantities.
- Up to four fixed pressure probes: current sample, cancellable whole-recording
  histories, and click-to-seek curves. Choose nearest fluid value or approximate
  inverse-distance weighting within a radius. No nearby fluid means a gap.
  Coordinates and radius use recorded units; no pressure is inferred from density.
  Sampling uses fixed stored coordinates; no tank-motion transform is inferred.
  Periodic domains use minimum-image distances. Probe definitions and samples are
  session-local. Live probes sample displayed snapshots (last 600), while recorded
  history can be scanned completely; a dedicated portable probe export is missing.
- Optional per-particle UID trace with separate past/future recorded-frame windows.
  Activate the plot's **Pick a particle (P)** tool, select a particle, and enable
  **Trace** in its bottom-right card. Past and future
  segments use different colors; missing identities and periodic seam crossings
  break the line. The target UID persists when stepping or seeking.
- Viewer-side periodic coordinate mapping from explicit domain metadata. Toggle
  **Wrap display coordinates** to compare wrapped and original coordinates.
  Recording arrays and trace samples remain unwrapped and unchanged.
- 2D reconstructed scalar grids, alone or with particles; Wendland C2/C4,
  preset or custom resolution on the longest side, volume weighting and Shepard normalization.
  Fluid coverage masks leave unsupported regions transparent. Requires recorded
  mass, density and compact cutoff supports; categorical quantities use particle
  display rather than reconstruction.
- Instantaneous velocity streamlines over the reconstructed field, with regular
  or picked fixed-position seeds. Midpoint integration runs in both directions,
  stops at invalid coverage, and splits periodic crossings. Overlay these with
  recorded UID traces to compare frozen-frame flow and temporal particle motion.
- PNG export of the GPU scene (without HTML labels, colorbar or chart).
- Offline and synchronized live VP8/WebM video with viewport metadata, colorbar
  and axes. Launch paused, configure the true initial frame, then Play to capture
  it before advancing. See [video requirements and recovery](reports/BUFFERED_CAPTURE_AND_VIDEO.md).

Units follow the stored arrays. Kinetic energy is `0.5 * sum(m * |v|²)` over
kind-0 fluid particles, maximum speed is a fluid-only maximum, and mean density
is an unweighted fluid-particle mean. Missing quantities remain unavailable;
missing mass is not replaced with unit mass. Specific `internalEnergies` arrays
are mass weighted: internal = `sum(m*u)`, total = kinetic + internal, fluid only.
Recorded `/diagnostics/internalEnergy` (or `thermalEnergy`) is also supported.
Total does not include gravitational, boundary work or other potential energy.
No equation of state is inferred when energy was not recorded. Nonfinite values invalidate the
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
in 3D, left drag orbits and right drag pans. Scroll zooms; activate the plot's picker to inspect a particle.
Use **P** to arm the particle picker and **Esc** to clear selection. The picked
particle card follows exact UIDs across frames and exposes its past/future trace
window. Controls are also available in the in-app help dialog.

## Viewer layout

Frame information and numerical diagnostics are on the left, visualization controls
on the right, and linked diagnostic charts along the bottom. Pressure-probe creation
and history generation live under the bottom **Pressure probes** tab. Pick a particle
from the plot toolbar to open its floating information/trace card.

The current trajectory appears at the top right. **Open trajectory** has separate
sections for example recordings (WCSPH, sloshing, KHH), analytical demos, files already
on this device, and local files/folders. Downloads are cached independently.
**Viewer settings** contains wrapping, backend selection, theme and file retention.
Theme/backend/wrapping preferences also persist without an open recording.

**Field view → Grid quantity** offers velocity divergence and signed 2D vorticity.
These are analytic derivatives of the normalized SPH velocity reconstruction, with
coverage masks and zero-centered automatic ranges. They are distinct from solver
operators; see [numerical contract](reports/VELOCITY_DERIVATIVES.md).

## Checks and dependencies

```bash
npm test
npm run build
# Optional Python service tests, after pip install -e '.[dev]':
pytest -q
```

React and TypeScript provide the UI, Three.js manages WebGL2, and Plotly provides
charts. HDF5 decoding uses [h5wasm](https://github.com/usnistgov/h5wasm), developed by
the National Institute of Standards and Technology, in a dedicated worker using
Emscripten WORKERFS. NPZ decompression uses fflate. Bundled notices are shipped
under `licenses/`. No external fonts or CDN runtime dependencies are used.
WebGPU compute reconstructs 2D grids in the file worker using compact cell ranges
and device-side prefix scans. **Viewer settings → Compute backend** defaults to Auto,
with explicit WebGPU and CPU reference choices. The selected backend is saved
with visualization settings. Auto reports any CPU fallback. Drawing still uses
WebGL2, so this first compute layer reads completed grids back for rendering and
CPU streamline integration. See [WebGPU implementation and timings](reports/WEBGPU.md).

Optional real-GPU checks (Dawn, a supported GPU/driver required):

```bash
npm run test:gpu
npm run bench:gpu
```

The browser also provides `?gpu-check=1` to run the numerical suite in a worker
on the client's adapter. No simulator, Python, or application server is required.

[Current feature inventory and prioritized roadmap](reports/ROADMAP.md),
[architecture and scope](reports/ARCHITECTURE.md),
[verification and known limits](reports/VERIFICATION.md), and
[evidence storage](reports/README.md) describe the current boundary.

Material analysis: pick a particle → **Track neighbourhood**, then use the bottom
**Material motion** tab for frozen UID sets and separation/local FTLE. The right
**Quantity analysis** controls open the separate spatial FTLE map. LIC is available
in the right field controls with CPU/WebGPU backends, including frozen-field animation.
See [material-motion contracts and limitations](reports/MATERIAL_MOTION.md) and
[LIC verification/performance](reports/LIC.md).

Expandable mapping/grid/flow controls, configurable fluid metrics, view URLs and
mapped-quantity histograms/spatial FFTs are described in
[view presets and analysis](reports/VIEW_PRESETS_AND_ANALYSIS.md). The example picker
also offers [high-resolution solver snapshots](reports/SNAPSHOT_GALLERY.md) with
direct HDF5 downloads. A reproducible KHH starting view is
[the density preset at t≈2.6](https://fluids.dev/warpSPHRemote/?demo=demo-khh-crksph-256&preset=khh).

## Local simulations

The optional Linux companion discovers running simulations, launches installed
case presets, pauses/resumes them and attaches one live browser viewer using
token-authenticated loopback HTTP. Opt-in trajectory export makes the growing
recorded history seekable alongside the live view. Preset launches attach
automatically; optional monitor mode follows newly launched external runs. Recorded-file viewing remains independent of Python/warpSPH.
See [installation, integration and limitations](reports/LOCAL_COMPANION.md).

The main page separates daemon connection, running simulations, run history, and
launching. The daemon discovers its installed case catalogue; the staged launcher
uses its parameter schemas when available. Generic coordinate, radial and vector
profile plots are available under **Quantity analysis → Profile / scatter plots**.
See [profiles and simulation workflows](reports/PROFILES_AND_SIMULATION_WORKFLOWS.md)
for controls, configuration requirements and reproduction checks.

The left **Live performance** tracker shows solver step/Δt, recent wall time per
step, remaining-time estimates, update intervals, frame download MB and MB/s.
Updated adapters also report process/system RAM and PID-attributed NVIDIA VRAM,
utilization, power and temperature. See [live metrics](reports/LIVE_METRICS.md)
for measurement definitions, optional hardware support and verification.

Refreshed/second viewers can explicitly **Take over connection**. An offline
companion now offers reconnect and recovers automatically when it returns.
Updated simulation adapters re-register surviving runs after a daemon restart,
including paused runs, so **Resume** and **Stop** remain available. See
[restart recovery](reports/LOCAL_COMPANION.md#viewer-takeover-and-daemon-restart-recovery)
for upgrade requirements and shutdown behavior.

Local companion pairing now persists per OS user/system across restarts. Retrieve
it after an implicit launch with `warpsph-companion --show-token`. Stop the daemon
and use `warpsph-companion --rotate-token` when you deliberately want a new token.

## 1D cases and retained run diagnostics

Native 1D file/live/history support and the durable run library are implemented.
Kidder uses its resolved compression duration and time-dependent physical shell
bounds. Completed runs, configuration and enabled measurements survive daemon
restart; managed exports/logs now live under the durable data directory.

Enable **Record physical and performance diagnostics** when launching to retain
physical reductions, configured probes, step throughput, RAM/VRAM and available
GPU utilization/power/temperature without requiring particle recording.
**Run history → Run report** provides charts, CSV, configuration and storage
inspection. **Forget entry** removes only the entry/diagnostic history; exports
and logs remain on disk. See [setup, formats, limits and verification](reports/ONE_DIMENSION_AND_RUN_LIBRARY.md).

## Useful next work

The next workflow improvements are portable analysis/launch recipes, case-specific
reference plots and comparison/export tools. The run library still needs deliberate
legacy import/reindex and more storage-management tools. Reconstructed 3D views,
shared GPU rendering and validated LCS methods remain separate gaps; direct remote
HTTPS work is parked in favour of SSH forwarding.
See [current status and remaining priorities](reports/ROADMAP.md).
