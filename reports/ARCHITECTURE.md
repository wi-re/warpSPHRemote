# Trajectory-first architecture

## Milestone boundary

Exercise rendering and UI/UX on existing trajectories before implementing live
simulation capture. There are no simulator changes, daemon auto-start semantics,
control hooks, live subscriptions, or cloud services in this milestone.

## Components

`python/warpsph_remote/sources.py` defines numerical frame sources. HDF5 and NPZ
adapters open recordings read-only, index metadata, and load requested frames.
The analytical sources exercise the same binary and rendering path.

`server.py` supplies a loopback-only HTTP file service and serves the built web
application. It has three bounded expensive-operation slots, independent HDF5
read handles, and a bounded cache of scalar diagnostic rows. It does not render.

`web/src/data.ts` decodes the versioned numerical frame contract. The browser
renderer receives a frame independently of how it was acquired. There is no
simulator object, plotting backend object, or Python callback in the scene.

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

Historical diagnostics run independently in 16-frame batches (maximum API batch
32); a missing current-frame diagnostic is requested separately. Browser history
is deduplicated by frame index. Long recordings still require reading dynamic
arrays to calculate diagnostics, and complete history storage is O(frame count).

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
