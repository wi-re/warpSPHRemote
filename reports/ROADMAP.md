# Visualization roadmap

Living plan, 2026-10-17. Track implementation and validation here as ideas become
concrete. The browser renderer stays independent of warpSPH and acquisition.
Saved trajectories remain the primary development fixtures; live adapters later
provide the same numerical contracts. Unwrapped recording coordinates are never
rewritten for presentation.

## Current iteration

- [x] Remember the last locally opened recording across refresh, with an explicit
  browser-local copy policy, visualization settings, storage failure handling, and a forget control.
- [x] Compressible energy diagnostics: internal = sum(m*u), total = kinetic +
  internal, kind-0 fluid only. Accept recorded global diagnostics or specific
  internal-energy arrays. Missing quantities remain unavailable; no inferred EOS.
- [x] 2D scalar/vector reconstruction on a regular grid with physical supports,
  volume weights, coverage masks, selectable resolution and explicit kernels.
- [x] Plot toolbar particle picking, floating UID/trace card, header trajectory picker,
  analysis left / visualization right, bottom pressure-probe tools and viewer settings.
- [x] Downloadable/cacheable 65K CRKSPH KHH preview alongside WCSPH and sloshing.
- [x] Instantaneous velocity streamlines from that same masked reconstruction,
  with controllable seeding, bounded integration and periodic seam handling.

Current delivered foundations: local HDF5/NPZ reading in workers, WebGL particle
rendering, colormaps, periodic display mapping, fixed pressure histories linked
to seeking, and one picked UID's past/future recorded particle trace. See
[verification](VERIFICATION.md) for evidence rather than treating this plan as a
completion claim.

Delivered in the next iteration: frozen material neighbourhoods and extra seeds,
cancellable cached temporal reads, linked separation/local-FTLE charts and fitted
ellipses; CPU/WebGPU LIC; sampled material FTLE maps with quality masks, export,
and explicitly limited scalar ridge candidates. See [material motion](MATERIAL_MOTION.md)
and [LIC](LIC.md). These are not general LCS or GPU rendering completion claims.

## 1. Reconstructed fields and instantaneous flow

### Scalar grids and vector grids

Start with 2D planes for KHH and sloshing; then add arbitrary 3D slices and volume
strategies after profiling. Reuse one reconstruction contract for raster plots,
velocity sampling, streamlines and LIC. Support fluid coverage and numerical
quality masks, periodic axes and correct units. Preserve the distinction between
raw SPH sums, Shepard normalization, and higher-order/CRK/MLS reconstruction.
Choosing a visualization kernel is not automatically the simulator's CRK method.
Do not interpolate categorical kinds, materials or UIDs as continuous scalars.

Validation: constant fields, affine reproduction where promised, nonuniform
particle volume, variable supports, periodic seams, dry regions, bad samples and
resolution convergence. Record wall time and memory outside Git before selecting
higher default grid resolutions. Move expensive reconstruction off the UI thread.

### Instantaneous streamlines

A curve tangent to velocity at **one fixed recorded time**. Integrate forward and
backward in space with bounded step size, length and steps. Stop at masked fluid,
stagnation or nonperiodic boundaries, and split display at periodic seams. Offer
regular seeds, manual seeds and seeds placed at selected particles. The origin of
a seed does not turn a steady-frame streamline into a time-dependent pathline.

Acceptance: uniform flow is straight, solid rotation closes appropriately within
integration tolerance, sink/saddle fields behave analytically, and no line bridges
a dry region or crosses a periodic box as a long chord.

### Line integral convolution (LIC)

Convolve a reproducible noise texture along the **instantaneous** reconstructed
velocity field. Share streamline integration and coverage rules. Controls: noise
scale/seed, convolution length, contrast, optional scalar colormap and velocity
magnitude overlay. Zero-speed and low-coverage regions require an explicit mask.
Investigate a GPU texture implementation after a deterministic numerical reference.
Avoid temporal flicker with stable noise when playing a trajectory; do not imply
that animated LIC represents actual particle transport.

## 2. Material motion and temporal flow

### Particle-seeded pathlines / recorded particle tracks

Extend the existing single picked-UID trace to multiple seeds. A selected particle
can provide an actual recorded material path through past n / future m frames.
Seeds can come from manual picks, a regular spatial selection, a region or a set
of UIDs. Distinguish these discrete recorded tracks from pathlines integrated
through a time-varying reconstructed velocity field. Show past/future colors,
time markers, optional fading and synchronized timeline selection.

Use exact UID lookup across reordering. Missing IDs create gaps; births/deaths do
not connect to a different row. Respect irregular recorded times. Original
unwrapped positions preserve multi-period travel; only display segments are mapped.
No fabricated substeps between sparse exports. Optional interpolation is a
separately labelled rendering choice.

### Local material-neighbourhood traces

Pick a center UID and select neighbouring UIDs **at the seed time**, by radius,
SPH support or k-nearest neighbours. Freeze this material set, then trace it
backward/forward. Do not silently replace it with each frame's current neighbours.
Show evolving cloud, separation relative to the center, deformation ellipses and
neighbor loss. Support local traces and a scalar measure of finite-time neighbour
separation, clearly named as such before a deformation-gradient estimator exists.

Validation: rigid translation/rotation preserves separation, known affine
stretch/shear, periodic crossings, row shuffling and missing material neighbours.
Consider that SPH particle shifting can change particle trajectories relative to
fluid transport; record whether tracks are material or numerical sample motion.

## 3. Lyapunov diagnostics and coherent structures

### Local finite-time Lyapunov exponent (FTLE)

From matched material neighbours at t0 and t1, fit a local deformation gradient F
using initial/final relative positions, with consistent periodic branches and an
explicit least-squares/MLS weighting. Compute C = transpose(F)*F and
FTLE = log(sqrt(lambda_max(C))) / abs(t1-t0). Report signed integration direction
separately from the nonnegative integration duration. FTLE values can be negative
for contracting flow; do not clamp them to zero.

Requirements: recorded physical time, nonzero duration, exact identities,
sufficient spatial rank, condition-number limits and explicit invalid masks.
Display neighbour count, fit residual, condition estimate and horizon. Sparse
sampling, particle shifting, missing neighbors and finite differences affect
interpretation. A pointwise separation ratio alone is not this deformation-gradient
FTLE, and a finite-time estimate is not an asymptotic Lyapunov exponent.

Validation gates: translation/rigid rotation gives zero; an analytic hyperbolic
flow recovers its stretching rate; shear matches the analytic finite-time value;
backward/forward directions, irregular time spacing, 3D rank and periodic branch
choices are covered. Add convergence studies in sampling density and time horizon.

### Flow-map FTLE fields

Sample seeds on a grid or at particles. Either use matched recorded material
tracks with the validated local fit, or integrate a flow map through recorded
unsteady velocity fields with explicit temporal interpolation. These are different
estimators and should be selectable/labelled. Batch in workers/GPU with bounded
caches, cancellation, progress and no queued playback backlog. Store derived
results separately with source fingerprint, t0, horizon, seed grid and algorithm
parameters; consider optional export/import for expensive analyses.

### LCS visualization

First render forward/backward FTLE scalar fields with quality masks. Ridge
extraction, filtering and optional material advection are separate steps. State
the adopted ridge/coherence criterion: bright FTLE regions alone are not a proof
of a material LCS. Consider stronger variational/geodesic methods only after
validated flow maps and spatial derivatives exist. Validate on established
analytic flows (e.g. time-dependent double gyre) before applying to free-surface
SPH. Define what fluid entry/exit and boundary impacts mean for each method.

### Asymptotic / variational Lyapunov analysis

Long-time exponents with repeated renormalization or tangent-linear integration
need additional numerical machinery and assumptions. Keep this distinct from
finite-time postprocessing of saved samples. Identify whether the simulator must
supply gradients/tangent state or whether reconstruction error is acceptable.

## 4. Shared engineering and UX

- Provenance for every derived field: source, actual times, coordinate convention,
  kernel/normalization, masks, seed policy, integrator and accuracy parameters.
- Selection and linked views: particle/region seeds, scalar curves, grid pixels,
  trace time markers and the shared timeline should seek consistently.
- Last-file visualization settings are retained. Further persistence: named view
  presets, camera, probes, temporal UID selections/windows and derived-analysis
  definitions; distinguish local handles from stored copies.
- CPU numerical reference first where useful, then measured WebGL/WebGPU paths.
  Do not imply GPU acceleration before it is implemented and verified.
- Live display snapshots may skip states. Complete temporal analysis needs a
  separate recording or sufficiently sampled diagnostic/material history; the
  pull-based display protocol alone cannot recover skipped trajectories.

## Suggested order

1. Delivered: initial UI/derivatives/demos and real-recording validation.
2. Delivered: frozen material sets, multiple tracks, local fit/FTLE and ellipse UI.
3. Delivered: CPU/WebGPU LIC. Next: shared GPU render/compute data paths to remove
   velocity re-upload and field readback; general CSR/operator parity as needed.
4. Delivered: CPU sampled material FTLE fields and simple scalar ridge candidates.
   Next: horizon/neighbour/sampling convergence, stronger ridge criteria and an
   independent velocity-integrated flow-map estimator before full LCS claims.
5. Add reusable analysis definitions/import/presets, then 3D slices as required.
6. More advanced Lyapunov/LCS methods and live acquisition requirements.

## WebGPU compute foundation (grids and normalized velocity derivatives implemented)

Use warpSPHCore as the numerical specification for a **selected forward-operator
subset**. Implement WGSL kernels with a shared typed browser API and parity
fixtures; do not introduce Python/Warp runtime dependencies or promise a literal
translation of its dispatch, autograd, JVP/HVP and simulator machinery.

The first grid milestone is implemented and measured; see [WEBGPU.md](WEBGPU.md).
It supplies packed local-coordinate buffers, GPU cell counting, hierarchical
exclusive scans, contiguous particle reordering, direct cell traversal and masked
Wendland C2/C4 grid interpolation. Auto/explicit backends work in the reader worker.
Analytic derivatives of normalized velocity now provide divergence and signed 2D
vorticity on CPU and WebGPU; see [VELOCITY_DERIVATIVES.md](VELOCITY_DERIVATIVES.md).
No linked lists or fixed neighbour capacity remain. The bounded dense 2D cell table
is not a literal port of the core's sparse occupied-cell hash table.

The following remains the broader operator roadmap. CSR adjacency, general point
queries, general core particle gradients/divergence/curl/Laplacians, correction variants, GPU FTLE and a
shared WebGPU renderer are **not implemented by the initial grid milestone**:


1. Define buffer/parameter contracts: SoA positions, supports, mass/density,
   field values, kind masks, query/reference sets, domain and support conventions.
   Keep unwrapped source data; use stable periodic/local coordinates for compute.
   Keep IDs exact on the CPU or in two u32 lanes rather than encoding them in f32.
2. Build spatial cell/hash indexing on device, including sorting/scans, periodic
   indexing, variable supports and explicit overflow/device-limit handling.
   Support direct cell traversal for one-off grid queries. Materialize CSR
   adjacency (count → prefix scan → fill) when several particle operators reuse
   it. Verify membership independently of neighbour order. Do not silently truncate.
3. Port interpolation and density/coverage with shared grid/probe point queries
   and explicit gather/scatter/support
   semantics. Add gradient, divergence, curl/vorticity and selected Laplacians.
   Match directionality/kinds, mass/volume factors, symmetric/difference forms,
   kernel gradients and periodic displacement exactly for each supported mode.
4. Add correction variants only when their dependencies and fixtures exist:
   Shepard, gradient renormalization, variable-h/grad-h terms and CRK/MLS. The
   current normalized viewer reconstruction is not already full CRK parity.
5. Reuse device buffers/adjacency for derived quantities, grid interpolation,
   streamline/LIC integration, local deformation fits and FTLE fields. Rebuild
   only what the current frame/identity/support revision invalidates. Do not use
   unsafe Verlet reuse merely because consecutive displayed frames look close.
6. Integrate compute and rendering on the same WebGPU device for derived textures
   and geometry. The current renderer is WebGL2; sharing a device-resident result
   with it is not automatic. A staging readback can bootstrap parity checks but
   should not be the steady per-frame path for large grid/volume fields.

Relevant core source areas: `radiusSearch/compactHash`, `radiusSearch/csr.py`,
`coreOperations/wp_interpolate.py`, `coreOperations/wp_gradient.py`,
`coreOperations/wp_divergence.py`, `coreOperations/wp_curl.py`, and kernel/domain
helpers. Pin the core revision in numerical fixtures. For divergence in particular,
its difference/symmetric formulations, consistent-divergence density factors,
directionality, CRK and renormalization switches are part of the operator contract.
A visually plausible image is not sufficient parity evidence.

Validation/engineering gates:

- Independent brute-force CPU neighbour reference, then comparisons to recorded
  warpSPHCore outputs at matching precision. Include irregular positions, mixed
  kinds, boundary/ghost data, variable support and periodic edges/corners.
- Constant/affine fields and known analytic divergence/curl, then real KHH/slosh.
  Specify numerical tolerances and distinguish summation-order differences from
  semantic errors. Do not promise bitwise equality across GPU implementations.
- Design initially around portable f32 arithmetic and integer atomics; do not
  assume CUDA-style f64 accumulation or floating-point atomic adds. Use gather
  kernels or staged reductions where appropriate. Detect optional capabilities.
- Measure upload, index/adjacency, operator, draw and readback times separately.
  Keep cache limits, cancellation, device-loss recovery and a worker CPU fallback.
  Static browser hosting remains sufficient; no application server is required.

References: [WebGPU specification](https://www.w3.org/TR/webgpu/),
[WGSL specification](https://www.w3.org/TR/WGSL/),
[GPU buffer/readback model](https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer).
