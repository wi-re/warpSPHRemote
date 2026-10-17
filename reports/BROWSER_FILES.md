# Browser files, deployment and live-adapter boundary

The website is a static browser application. Local HDF5 reads happen in a worker
using [h5wasm WORKERFS](https://github.com/usnistgov/h5wasm#worker-usage), which
supports random File access without loading the whole file into a virtual disk.
There is no upload endpoint, CDN fetch, or simulator import in the default flow.

## Recommended recording layout

For fixed row identity, use:

```
/domain/min                   float64 [D]  # optional explicit box
/domain/max                   float64 [D]
/domain/periodic              uint8   [D]  # 0/1 per axis
/time                         float64 [T]
/particles/UIDs               int64   [N]
/particles/kinds              int32   [N]
/particles/masses             float32 [N]
/frames/positions             float32 [T,N,2 or 3]
/frames/velocities            float32 [T,N,2 or 3]
/frames/densities             float32 [T,N]
/frames/pressures             float32 [T,N]
/frames/internalEnergies      float32 [T,N]  # optional specific internal energy
/frames/supports              float32 [T,N]
/diagnostics/kineticEnergy     float64 [T]  # optional, fluid only
/diagnostics/maxSpeed          float64 [T]  # optional, fluid only
/diagnostics/meanDensity       float64 [T]  # optional, unweighted fluid mean
/diagnostics/particles         int64   [T]  # optional, fluid count
/diagnostics/internalEnergy    float64 [T]  # optional, sum(m*u), fluid only
/diagnostics/totalEnergy       float64 [T]  # optional, kinetic + internal
```

The four base diagnostics are used when all four arrays are present and match T.
Otherwise the reader calculates them. Global internal energy can be read
independently; total is calculated as kinetic plus internal. Specific-energy
arrays are used when global internal energy is absent. Missing or nonfinite
energy remains unavailable. No EOS or unit-mass fallback is used. Times must be finite and nondecreasing;
spatial datasets must be finite nonempty N×2 or N×3. Fields are discovered from
the first frame. Units follow stored values; the UI currently does not interpret
unit attributes. Particle pressure needs a scalar recorded array (`pressures`,
or alias `pressure`); no equation of state is assumed.

Chunk dynamic datasets with **one time slice per chunk**, optionally several
spatial chunks per frame, e.g. `(1,8192,2)` or `(1,8192)`. Standard gzip/deflate
and shuffle are supported; arbitrary external HDF5 filter plugins are not. Avoid
chunks spanning the whole time axis: random scrubbing would decompress unrelated
frames. Store UID/kind/mass once only if they truly remain row-aligned and constant.
Per-frame identity arrays or nested state groups are required for reordering or
changing populations. A file containing only initial identity cannot reconstruct
unrecorded changes. The recommended stacked layout uses a fixed N.

The reader also supports native legacy warpSPH columns, nested state groups and
single checkpoints. NPZ supports numeric C-order NPY arrays, including 64-bit
IDs, either endian. Object arrays/pickles and Fortran-order arrays are rejected.
Each compressed NPZ snapshot is buffered and decompressed as a unit; HDF5 is
preferable for very large recordings. If no physical time is present, NPZ uses an
explicit frame-index axis. File selection (including optional measurements.json)
is local. With **Remember last recording** enabled, one copy is stored in
IndexedDB and automatically restored on reload, along with its frame and visualization settings (details below).
Opt-out and forget controls are in the open dialog. Saving is asynchronous;
wait for “Saved for refresh” before reloading. Failure to save does not prevent
viewing. Copies do not track later changes to the original files. Browser quota
and eviction can remove them; this is session convenience, not archival storage.
See [browser storage rules](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria). Drag/drop supports files; select a
folder with the folder picker rather than dropping a directory.

Worker memory is bounded for retained frames, not universally constant: decoded
frame buffers, temporary decompression memory, HDF5 WASM memory and GPU buffers
still matter. Browser process limits and frame size are practical constraints;
chunking cannot make an individual enormous frame free. WASM memory may retain
its high-water mark until closing the recording terminates the worker.

## Periodic display and particle traces

Coordinates are read and retained exactly as recorded. The renderer wraps only
its display buffers on periodic axes, using `/domain/{min,max,periodic}`. Native
`config/config/domain` list attributes and `config/domain` datasets are also
understood. NPZ can provide `domain_min`, `domain_max`, and `periodic` arrays in
the first snapshot. Bounds are never guessed from particle extents. Missing
metadata leaves coordinates unwrapped. The inspector exposes a display toggle;
changing it remaps the scene and refits the camera. Scalar fields and diagnostics
are unchanged. Pressure probes use minimum-image distances in declared periodic
axes independently of the display toggle.

The picked UID can be traced over n past and m future **recorded frames**, clipped
to available data (each control allows 0–1000). This is one selected UID at a time.
Each source-frame lookup uses the exact UID, rather than assuming stable row
indices. Worker batches are cancellable and lower priority than scene reads;
changing source, UID, window or frame invalidates stale results. Original unwrapped
positions are retained in trace samples. Past/future colors are distinct. Missing
UIDs create gaps, and a wrapped trace omits the segment spanning a periodic seam
rather than drawing a jump across the box. The unwrapped display draws original
continuous segments; there is no temporal interpolation or invented motion between
exports. A white marker indicates the current position when it is present.

## Hosting

`npm run build` produces `dist/`. The default relative asset base supports static
subpath hosting. `.github/workflows/pages.yml` uses GitHub's configured base path
and deploys `main`; it does not run Python. No COOP/COEP headers or shared-memory
WASM threads are required by this reader. GitHub serves the app code, while local
recordings consume neither Pages storage nor its transfer allowance.

## Later local simulation adapter

A hosted page's JavaScript runs on the viewer's device. `localhost` therefore
refers to that device. A private IP requires actual network reachability or VPN.
The current viewer **does not yet expose a live adapter connection**. The optional
Python file-service mode is a same-origin development path, not a general remote
connector.

A later adapter must handle CORS and Origin checks, browser local-network
permissions, and HTTP(S)/WS(S) compatibility. An HTTPS page to a plain local
endpoint cannot be promised uniformly across browsers. See
[MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)
and [Chrome's implementation](https://developer.chrome.com/blog/local-network-access).
Do not require users to disable browser security protections.

Display snapshots can be skipped by the proposed pull/ack protocol. A complete
live pressure history needs a separate simulation-side sampler or recording of
all desired diagnostic times; reconstructing it from skipped display snapshots
would silently lose pressure impacts. A browser disconnect must not erase that
history. This acquisition work remains separate from file/probe rendering.

## Grids and instantaneous streamlines

2D only in this iteration. Reconstruction samples cell centers and scatters each
fluid particle's compact-support kernel with volume m/rho. It uses Shepard
normalization, sum(V W f)/sum(V W), with an explicit Wendland C2 or C4 kernel.
The supports array is interpreted as the **cutoff radius**, matching warpSPH's
convention. This is a viewer reconstruction, not a port of CRK corrections.
Vectors are reconstructed before magnitude is calculated. Invalid field samples
mask affected cells; invalid mass/density/support particles are excluded and
counted. Coverage is the dimensionless raw sum(V W); the threshold is adjustable,
not an exact geometric free-surface test. Boundaries/ghosts are not included in
this fluid reconstruction, although they can remain visible as particles.

For a declared periodic wrapped view, splats and velocity sampling respect the
periodic axes. Unwrapped mode reconstructs original coordinates over current
particle extents. Grid computations and streamline integration run in the browser
reader worker. One reconstructed grid is cached independently of the small raw
frame cache. A 40-million candidate-contribution cap rejects expensive requests
with a suggestion to reduce resolution; it never silently truncates neighbours.
The optional legacy Python-service mode computes the same reconstruction in the
main thread after fetching arrays. Neither path currently uses WebGPU compute.

Instantaneous streamlines use bilinear masked velocity samples and normalized
midpoint/RK2 steps of 0.45 minimum cell width, up to 400 steps per direction, plus
loop/stagnation/domain checks. All four interpolation cells must have valid
velocity coverage. Regular seeds use 2–16 points per axis. A picked spatial seed
stays fixed while stepping; it does not follow the UID. Wrapped lines omit seam
segments rather than drawing chords. These curves are not time-dependent
pathlines. Existing UID traces can be overlaid for comparison; richer material
seeding, LIC and FTLE/LCS are tracked in [the roadmap](ROADMAP.md).

Scalar grids are drawn with a WebGL float texture and the same LUT/normalization
as particles. Texture sampling is nearest-cell; change grid resolution to study
sampling effects. Auto color limits come from finite grid samples when the grid
is shown, and the same limits apply to the particle overlay. Float32 graphics
precision, coverage errors, sparse export times and reconstruction choices remain
scientific limitations. No spatial derivative or LCS result is advertised yet.

## Completed-frame playback and settings

A display request now returns its particle arrays and requested grid/streamlines
as one completed presentation. Playback waits for that presentation before
advancing, and the renderer updates both before its next draw. The last complete
scene stays visible while reading/reconstructing the next; it never silently
switches a selected grid to particles. Display time, diagnostics and trace markers
follow the completed frame; the scrubber thumb shows the requested frame, with
an arrow when it is ahead. Pausing leaves the in-flight target free to complete.

Paused grid scrubbing uses a 60 ms debounce and cancels obsolete queued work.
An already-running synchronous worker kernel can still finish before the latest
target starts. Particle-only mode requests no grid. Playback includes load/compute
time in its frame interval, rather than adding a full interval after each load.
True grid/streamline playback is still bounded by CPU reconstruction cost; this
change does not claim particle-only throughput or WebGPU acceleration.

The remembered file's view record includes field, component, palette, normalization,
automatic/fixed limits, particle size/visibility, background/reference grid, periodic
mapping and clip plane, plus display mode, resolution/kernel/coverage, streamline
seed policy/count/fixed position, diagnostic tab, playback speed and loop. Legacy
frame/field-only records remain readable. Unsupported/nonfinite stored settings
fall back safely. Playback restores paused; camera, pressure probes and temporal
UID selections/windows are not persisted yet. Forget removes both file and view.

## Shipped solver recordings

The static demo catalogue has two explicit downloads: seeded decaying WCSPH
random flow and the sloshing tank. The UI shows particle/frame counts and size
before download. They use the same HDF5 worker, rendering and diagnostics paths
as local files. Downloads honor the configured Pages base path and support
progress, cancellation, size checks and SHA-256 verification. No trajectories
are prefetched on first visit. A selected demo can be retained as the one local
copy when remembering is enabled; refresh uses that copy and restores settings
without downloading again. Closing a recorded demo releases its worker and
returns its download card. Analytical demos remain always available.

These two curated product data files are intentionally committed; full solver
outputs remain outside Git. See [their provenance](RECORDED_DEMOS.md).
