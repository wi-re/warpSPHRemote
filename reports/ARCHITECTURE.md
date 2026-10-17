# Trajectory-first architecture

## Milestone boundary

Exercise rendering and UI/UX on existing trajectories before implementing live
simulation capture. There are no simulator changes, daemon auto-start semantics,
control hooks, live subscriptions, or cloud services in this milestone.

## Components

`web/src/sources/client.ts` defines the trajectory-source interface used by the UI:
metadata, requested frame, diagnostic batch, probe batch, and close. The default
`BrowserSource` creates one module worker per recording. Opening a local file
passes a browser `File` handle to that worker; it never sends its contents to an
HTTP endpoint. The two analytical sources use this same worker path.

`reader.worker.ts` mounts an HDF5 File in Emscripten WORKERFS for random access;
`hdf5.ts` indexes legacy columns, nested states, checkpoints, or stacked frame
datasets and slices only the requested frame. `npz.ts` decompresses one snapshot
at a time. Native numeric dtype is preserved until display conversion. Raw cache
retention is capped at two frames and 64 MiB, excluding temporary decode buffers
and the library's own memory. At most four non-demo recordings remain open.

`ServiceSource` is an explicit `?service=1` alternative for the existing same-origin
Python WPR1 API. The service remains loopback-only and does not render. It depends
only on NumPy/h5py; there is no simulator dependency in either file-reading path.
The renderer receives typed frames independently of how they were acquired.

`web/src/renderer.ts` implements instanced camera-facing quads, circular coverage,
3D sphere surface depth, palette lookup, normalization, and physical marker
sizes in custom GPU shaders. Three.js provides graphics resource and camera
management. Geometry buffers are updated in place for constant particle counts;
old GPU resources are disposed when population size changes. The scene redraws
on changes; a paused, untouched viewer does not submit renders every RAF tick.
Browser GPU work still shares hardware with a local GPU simulation.

React owns the surrounding interface; Plotly owns diagnostic histories.
Coloring changes operate on retained arrays. Selecting another field requests
that field from the source. PNG export currently captures only the GPU canvas.

## WPR1 frame format

- Four magic bytes `WPR1`, then a little-endian uint32 JSON-header byte length.
- UTF-8 JSON header with `version: 1`, frame `index`, simulation `time`, and
  `arrays` descriptors. Each descriptor gives `dtype`, `shape`, byte `offset`,
  and byte count.
- Pad the header to a multiple of 8 bytes. Array offsets are relative to the
  payload start after that padding. Each array begins on an 8-byte boundary.
- Numerical arrays are little-endian float32, int32, or int64. Float64 source
  display values are downcast to float32; diagnostics are calculated from source
  arrays using float64 accumulation. Int64 identity stays exact through browser
  `BigInt64Array`; display coloring of integers uses float32 and is approximate
  for large identities. Unsigned identities above signed int64 are rejected.

A frame contains positions and available kinds, IDs, masses, supports, densities,
and the requested field. Static metadata is currently retransmitted. Caching
static metadata across the wire is deliberately deferred until live transport
is designed. WPR1 is an initial internal contract, not a released interoperability
standard. It assumes a little-endian browser platform.

## Playback and concurrency

Playback requests one next frame after the current frame has loaded. Inter-frame
delay follows recorded time divided by playback speed; frame-index sources use
100 ms per frame at speed 1. Read and preparation time adds to that interval.
Playback never tries to catch up by queuing timestep requests. Manual seeks and
field/source changes cancel stale browser requests; already-started server reads
may complete, with expensive server operations limited to three at a time.

Historical diagnostics run in bounded eight-frame batches; current-frame reads
have priority. Each worker has a single in-flight operation and a priority queue.
Aborting discards queued work and rejects the caller immediately; a synchronous
HDF5 read already running can finish before the next operation starts. Stale
responses cannot replace a newer frame. Display buffers are copied before being
transferred, preserving the raw cache. Large JS preparation/GPU upload still
runs on the main thread.

Pressure probes sample current frames automatically. An explicit scan calculates
all configured probes in four-frame batches with lower priority, cancellation,
and generation invalidation when a definition or source changes. Click targets
carry recorded frame indices; seeking does not infer indices from uniform dt.
No-pressure/dry samples are null and Plotly does not connect gaps. Definitions
use fixed stored coordinates; IDW (1/r²) and nearest-neighbour within a finite
radius are approximate sampling choices, not solver-kernel reconstruction.
Histories cost O(probes × frames × particles) work and O(probes × frames) storage.
All current histories and definitions live only in the tab session.

A later live source can provide metadata and requested numerical snapshots to
this boundary. It will need explicit pending-capture/owned-snapshot semantics,
identity revisions, and a separate diagnostic history policy. No current file
reader needs to become a simulation integrator.

## Scientific semantics

Kind 0 is fluid, kind 1 boundary, and kinds greater than 1 are controlled by the
ghost visibility setting. Fluid values determine automatic limits. Passive kinds
are gray. Positions must be finite. Bad numerical field values remain gray and
are excluded from automatic limits; nonpositive log samples are also excluded.
The current linear/symmetric-log rules are documented in the README.

The reference box follows the first frame's particle extent. It is not a physical
domain declaration. Current-frame fitting does not continuously reset the camera.
Clipping is a particle visibility operation, not SPH field reconstruction.

## Deferred visualization work

Browser-side SPH interpolation and coverage masks, grid/volume rendering,
streamlines, reconstructed surfaces, arbitrary clipping planes, linked multi-view
layouts, temporal particle tracking, accurate data-space axis ticks, colorbar-
inclusive publication exports, and a WebGPU backend remain separate work items.
