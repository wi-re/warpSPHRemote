# Current architecture

Updated 2026-10-18. [Status and priorities](ROADMAP.md) is the feature inventory;
linked reports below define numerical and lifecycle details.

## Browser sources and rendering

`web/src/sources/client.ts` defines the acquisition boundary: metadata, requested
frame, diagnostics/probes, exact-UID temporal/material reads, reconstructed fields,
LIC and scalar analysis. The renderer never imports a solver. Sources include
browser-local files/demos, optional same-origin Python file service, live companion
snapshots and companion recorded-history replay.

Browser files are read in a module worker. HDF5 uses h5wasm WORKERFS and requested
frame slicing; NPZ snapshots are decompressed individually. Native identity types
remain exact until display preparation. Bounded caches and prioritized jobs keep
foreground requests ahead of scans; synchronous reads already started may finish
after cancellation, but stale results cannot replace the selected frame.
See [formats](BROWSER_FILES.md) and [pacing](RECONSTRUCTION_PACING.md).

Native 1D uses `ProfileRenderer.ts`, a Canvas 2D viewport behind the same render/
ACK/export lifecycle. Numerical axes and signed quantity samples use N×1 source
arrays directly. Optional frame geometry distinguishes moving physical boundaries
from computational domains; Kidder metadata is produced by the trusted adapter.

`renderer.ts` draws WebGL2 instanced discs/sphere impostors, reconstructed textures,
flow overlays, material traces and selection. It owns camera/controls and reuses
buffers where possible. Paused unchanged scenes do not continually redraw; LIC
animation is an intentional exception. Source coordinates stay unwrapped; periodic
mapping is presentation-only. GPU uploads/display preparation and projected
particle picking still use the main thread.

Grid reconstruction and normalized velocity derivatives have independent CPU
reference and WebGPU worker implementations. The GPU index uses cell counts,
prefix scans and contiguous cell ranges, not linked lists or a fixed neighbour
capacity. Cooperative batches yield/cancel expensive work without arbitrary
candidate-count rejection. Completed grids are read back for WebGL2 drawing and
CPU streamline integration; this is not a shared WebGPU renderer. LIC has CPU/GPU
compute with renderer-side animation. See [WebGPU](WEBGPU.md),
[derivatives](VELOCITY_DERIVATIVES.md) and [LIC](LIC.md).

React owns UI state; Plotly owns curves/scatter/FFT displays. Generic profiles use
separate bounded workers. Material fits/maps use exact recorded UID motion and
quality masks; they are not a general velocity-integrated LCS solver.
See [profiles](PROFILES_AND_SIMULATION_WORKFLOWS.md) and
[material contracts](MATERIAL_MOTION.md).

## Local simulation acquisition and control

The optional Linux companion (`daemon.py`) owns a singleton registry, authenticated
viewer/control endpoints, installed-case discovery and managed process launch.
Its ordinary endpoint is loopback HTTP; SSH forwards this without changing the
protocol. Pairing persists per OS user/system. A single viewer lease can be
explicitly taken over. The browser separates connection, running runs, history
and staged launch tasks.

`publisher.py`/`simulation_worker.py` integrate at consistent solver boundaries.
Unwatched runs send metadata, not particle states. Normal live capture holds one
owned CPU copy while a background worker checks/encodes/publishes it; controls and
resource sampling have their own worker. The next capture follows viewer ACK and
the configured minimum interval. Static identity arrays are revisioned and fetched
separately rather than copied over the viewer connection every frame.

Pause simulation and pause updates are independent. Paused identical boundaries
do not cause repeated reconstruction. Producers re-register after daemon restart,
including paused and video-held runs. `library.py` transactionally persists
completed run/configuration/recording manifests and enabled scalar/resource
histories; loaded active entries wait for producer recovery rather than claiming
a saved PID. Newly managed output lives in this durable data tree.
See [companion](LOCAL_COMPANION.md), [recovery](RECONNECTION.md),
[metrics](LIVE_METRICS.md) and [buffering](BUFFERED_CAPTURE_AND_VIDEO.md).

Case availability/schema discovery runs in the daemon-selected installed solver
Python. Browser overrides are finite, sparse, bounded configuration data; the
companion owns executable, device, paths and lifecycle. The solver resolves and
validates its own versioned configuration before launch. No browser-supplied Python,
shell or arbitrary output paths are accepted. `warpSPHCases` reference/figure
metadata is not integrated yet.

Recording is off by default. When enabled, the adapter exposes its existing
exports as history. Active HDF5 readers run between writes on the producer thread;
this is not arbitrary concurrent HDF5/SWMR access. Finished history can be read by
the daemon after the writer closes. Browsing history does not change pause state.

Direct HTTPS has a separate explicitly enabled listener/token; incidental starts
cannot enable it. This optional networking branch is parked: use localhost/SSH.
See [transport implementation](REMOTE_CONNECTIONS.md) only if it is needed later.

## Packets, histories and scientific semantics

WPR1 is an internal versioned binary packet: magic, little-endian JSON header
length, UTF-8 descriptors, padding and aligned numerical arrays. Float32 display
values, int32 and exact signed int64 IDs are supported. Float64 source values may
be downcast for display; numerical reductions use source arrays with float64
accumulation where supported. No public interoperability standard is promised.
Packet allocation budgets are configurable and independent of a fixed particle
count; GPU limits and available CPU/browser memory still apply.

Live display is a sampled stream, not a complete trajectory. Bounded live metric
and pressure histories contain displayed snapshots only. Complete temporal
analysis needs opt-in particle recording or a future diagnostic recording path.
Missing identities, invalid numerical samples and dry probe regions produce gaps.
Kind 0 defines fluid reductions; missing mass/pressure/energy is not fabricated.
Total energy currently means kinetic + internal, excluding potential energy.
Viewer reconstruction kernels/derivatives are not assumed to match the solver's
CRK or other correction operators.

## Retention and export

IndexedDB retains one local recording copy plus independent demo caches. A small
localStorage view record saves supported rendering/analysis settings. Profile
cards are separately keyed by source name. Camera, probes and material selections
are not a portable workspace. This is stored file data, not a live filesystem
handle, and browser quota/eviction applies.

Video uses an explicit viewport/metadata composition and WebCodecs VP8/WebM.
Offline export waits for rendered frames. Live export gates due solver boundaries
on render/encode ACKs, including configured initial t=0 and final handoff.
Unrecorded viewer dropout holds the solver until explicit recovery/release;
recorded runs can continue for offline regeneration. Encoded output stays in
browser memory until download. Ordinary PNG still captures only the GPU canvas.
See [video contracts and verification](BUFFERED_CAPTURE_AND_VIDEO.md).

No generated states, images, videos, logs or builds belong in source apart from
explicitly curated demo product data. [Evidence storage](README.md) describes the
external development tree and reproduction commands.


## Persistent measurements

`measurements.py` reduces solver arrays to scalars at requested simulation-time
boundaries, including configured fixed probes. A bounded producer queue sends
idempotent batches; low-rate resource/throughput status is persisted separately
from live frame pulls. The recorder is opt-in and independent of particle export.
`RunReport.tsx` paginates retained rows and provides charts/CSV; only 50,000 rows
are retained for display. Recording I/O errors preserve control operation and
leave a warning. [1D/library contracts](ONE_DIMENSION_AND_RUN_LIBRARY.md) cover
paths, geometry layout, sampling, limitations and reproduction.
