# WebGPU grid compute layer

Implemented 2026-10-17. Browser-only trajectory viewing remains supported on
GitHub Pages. No simulator dependency or file upload is introduced.

## Delivered path

`GridBackend` in each source worker lazily acquires an adapter/device. Auto prefers
WebGPU and records the CPU fallback reason; explicit WebGPU fails visibly when it
cannot run. CPU reference is selectable. Backend preference is retained with the
last file's visualization settings. Particle-only viewing never initializes GPU
compute. The optional Python service adapter uses the same backend contract.

The passes are:

1. Pack the snapshot into local f32 coordinates and attributes. Periodic mapping
   happens in CPU double precision before conversion. Original positions and exact
   UIDs are untouched; IDs are not encoded as floats.
2. Clear cell counts and scatter cursors; count valid fluid particles per cell.
3. Hierarchical exclusive u32 prefix scan on device (128 lanes/block), recursively
   scan block sums, then add block offsets. This is reusable for future CSR work.
4. Scatter complete particle attributes into contiguous cell ranges.
5. Each grid query traverses neighboring cell ranges and accumulates its own
   field, velocity and coverage. No floating-point atomics or pointer chasing.
6. Read back the complete grid and publish it atomically with its matching frame.

This applies the core's contiguous cell-range principle, rather than its exact
hash map implementation. The dense bounded 2D cell table is at most 512×512 cells;
there are no hash collisions. Cells have no fixed occupancy limit and no neighbors
are truncated. Particle order within each cell is unspecified. The index is rebuilt
for each reconstructed snapshot, avoiding unsafe temporal neighbor reuse. Device
and allocated buffer capacities are reused. There is no GPU-resident multi-frame
cache or UID-based immutable-attribute upload cache yet.

## Numerical contract

Matches the viewer CPU reference: kind-0 fluid only; particle cutoff radii `h_j`
(scatter supports); physical volumes `mass/density`; 2D Wendland C2 (7/pi) and C4
(9/pi); minimum-image periodic distances; scalar/vector interpolation normalized
by coverage. Vector magnitude is taken **after** vector reconstruction. Invalid
physical volumes/supports are excluded; invalid contributing field/velocity values
mask their respective outputs. Dry cells stay transparent. Each periodic cell is
visited once even with supports exceeding the box size.

Kernel/support conventions were checked against warpSPHCore revision
`8f5dd4449bee4b7591b438f090ec95bb787a3390`, especially `kernels/kernel.py`,
`kernels/kernelFunctions/wendland2.py`, `wendland4.py`,
`coreOperations/wp_interpolate.py`, and `radiusSearch/compactHash/buildHashmap.py`.
The viewer's Shepard normalization is an additional operation; raw core SPH
interpolation is not implicitly normalized. This is not a claim of full core
operator parity, directionality variants, CRK, or gradient renormalization.

Portable f32 accumulation differs from CPU f64 and is order dependent. The parity
suite requires matching validity masks and `|GPU-CPU|/(1+|CPU|) <= 8e-5` at every
finite sample. Values exactly at cutoff/coverage thresholds can differ with
roundoff; no bitwise or threshold-boundary guarantee is made. Up to four selected
field components are supported by this GPU path; wider fields fall back in Auto.
Unsupported f32 scales and device buffer/dispatch limits produce explicit errors
or a reported CPU fallback. There is no total candidate/work-count rejection for
grid reconstruction; large CPU and GPU jobs use cooperative chunks.

GPU capacity allocations, including retained scan scratch and readback, are capped
at 192 MiB per source backend. A conservative candidate-visit estimate schedules
query ranges targeting 16 million visits per submission; it never clips neighbours
or rejects an otherwise valid dataset because its total work exceeds that target.
The compact index is built once. Each range reconstructs and differentiates its
own cells, then yields through queue completion before the next range. CPU
reconstruction uses the same accumulation order with cooperative yields every
65,536 candidate visits. Both paths check cancellation between chunks. Unavailable adapters, device loss and allocation/
validation failures cannot publish partial output. Serialized source jobs and
existing presentation cancellation prevent stale results from replacing a newer
frame. Closing a browser source terminates its worker; service sources close their
device explicitly. Failed adapters are remembered until the source is reopened.

## Measured validation

Actual WGSL execution used Dawn `webgpu` 0.6.2 on NVIDIA Blackwell, driver
610.43.02. The embedded test browser had no WebGPU adapter: browser integration
there verified Auto fallback, explicit-GPU errors, recovery, grid playback and
streamlines. Browser-native GPU playback on another client remains a separate
hardware/browser compatibility check; the Dawn run does not establish it.

- 37 normal TypeScript/data/persistence/presentation tests passed, plus production
  build. These do not pretend to execute shaders.
- Six exact GPU scan cases: 1, 127, 128, 129, 16,385 and 262,144 integers.
- 21 real GPU/CPU cases: both kernels, 128/256/512 grids, scalar/vector magnitude,
  component mapping, mixed kinds, variable supports, unwrapped periodic positions,
  missing/invalid samples, nonperiodic/partly periodic domains, constant fields,
  empty fluid populations, four-component fields and a crowded single cell with
  1,001 particles. Worst scaled error was below 1.9e-6.
- Both committed HDF5 demos, first/middle/last frames at every resolution, three
  repetitions per frame. Every output sample was compared. Worst scaled error
  across those checks was below 3.8e-6; masks agreed.

Median reconstruction wall time, 9 warmed samples per row:

| Recording | Longest grid side | CPU reference | WebGPU complete |
|---|---:|---:|---:|
| Random WCSPH · 16,384 fluid | 128 | 55.67 ms | 4.18 ms |
| Random WCSPH | 256 | 199.64 ms | 6.81 ms |
| Random WCSPH | 512 | 739.98 ms | 10.29 ms |
| Sloshing · 4,200 fluid | 128 | 6.78 ms | 1.08 ms |
| Sloshing | 256 | 22.16 ms | 2.05 ms |
| Sloshing | 512 | 75.12 ms | 2.69 ms |

WebGPU complete includes CPU validation/packing, uploads, index/scan/reordering,
interpolation, readback and unpacking. It excludes first-time device/pipeline
initialization, HDF5 decoding, CPU streamlines, transfer to the UI and rendering.
These are reconstruction timings on one machine, not browser FPS or portable
speedup guarantees. GPU pass timestamps are not yet collected separately.

## Reproduce

```bash
npm ci
npm test
npm run build
npm run test:gpu
npm run bench:gpu
# Or open the static viewer with ?gpu-check=1 and press Run GPU checks.
```

Dawn is a development dependency only, never shipped into the browser bundle.
`examples/check-webgpu.mjs` bundles the exact production TypeScript/WGSL into a
unique temporary module; it does not maintain a different shader implementation.
`DAWN_BACKEND=vulkan` optionally selects a Dawn backend. Tests need a supported
local driver/adapter and may need GPU device access outside a sandbox. Store output
outside the checkout, e.g. `../warpSPHDevelopment/remote/webgpu-grid-20261017/`.
This run's raw logs and browser captures live there; disposable staging evidence
is under `/tmp/warpsph-gpu-evidence-20261017/`.

## Velocity-derivative and UI follow-up

Normalized velocity divergence and 2D vorticity are now implemented on both CPU
and WebGPU, with an additional pass over the same compact cell ranges. See
[VELOCITY_DERIVATIVES.md](VELOCITY_DERIVATIVES.md) for formulas, tolerances, analytic
checks and real-recording timings. The original grid interpolation measurements
above remain historical evidence from that first milestone.

Backend selection moved to **Viewer settings** alongside wrapping/theme/retention.
Frame metrics are left, visualization controls right, charts/probe tools below,
and picking/trace controls are on the plot. [UI contract](VIEWER_UI.md).

## Remaining work

The current renderer is WebGL2. Readback and a second texture upload remain, and
instantaneous streamline integration is still CPU. This is the first compute
milestone, not a fully GPU-resident renderer. A common WebGPU compute/render device,
general point-query buffers, reusable CSR adjacency when multiple operators need
it, general particle operators/gradients and their core parity fixtures, 3D sparse indexing,
LIC, temporal flow maps and FTLE/LCS remain on the roadmap. A sparse occupied-cell
hash index becomes useful when the dense table is wasteful, especially in 3D.

References: [WebGPU](https://www.w3.org/TR/webgpu/),
[WGSL](https://www.w3.org/TR/WGSL/),
[Dawn Node bindings](https://github.com/dawn-gpu/node-webgpu).

## Large grids and frozen live frames (2026-10-18)

The former 160M GPU candidate cap and 40M CPU work cap are removed. Long jobs keep
the completed display visible until the matching result is ready. See
[cooperative reconstruction and paused-frame verification](RECONSTRUCTION_PACING.md)
for the actual triple-point check, cancellation tests and non-blocking error UX.
