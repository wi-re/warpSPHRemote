# Material motion and finite-time deformation

Implemented 2026-10-17. No simulator runtime or server is needed. The material
analysis consumes exact UID/position arrays through the existing frame source.

## Viewer workflow

Pick a particle with the plot cursor. **Pin seed** retains up to eight extra UIDs
for the next capture. **Track neighbourhood** selects up to 64 fluid neighbours
at the displayed seed frame, using nearest distance, a physical radius, or the
selected particle's recorded cutoff support. The bottom **Material motion** tab
contains the selection policy for the next capture, past/future windows, pause /
resume, visibility/fading and fit-ellipse controls. Extra pinned seeds are drawn
but excluded from the local deformation fit.

The captured set stays fixed through subsequent playback and selection changes.
Missing, duplicated or inexact UIDs produce gaps; array rows never replace UIDs.
A single frame scan resolves all selected identities. Temporal reads run one frame
per low-priority reader job; foreground frame/grid requests take precedence between
jobs. Cancellation removes queued work and ignores an in-flight result. Raw-frame
cache remains bounded at two frames / 64 MiB; material history is bounded at 1001
frames and 73 identities. Source changes clear histories. Shortening/expanding the
window reuses retained material samples; analysis does not restart on every seek.

Past and future segments are mint and gold, the center is white, and current
material positions have pink markers. Fading darkens older segments. Wrapping is
presentation only: wrapped seam crossings and absent frames break drawn lines.
The material chart displays RMS radius or local 2D FTLE, using actual recorded
physical times, with clickable samples that seek exact frame indices.

## Numerical contract

At t0 choose the minimum-image displacement r_j0 from center to each neighbour.
At t1 retain that branch using

`r_j1 = (x_j1-x_c1) - (x_j0-x_c0) + r_j0`.

This uses original unwrapped coordinates and preserves arbitrarily large subsequent
relative travel. It does not repeatedly wrap stretched neighbours back toward the
center. Files containing only wrapped coordinates cannot resolve multi-period
relative travel unambiguously and should not be interpreted as such.

Fit a center-anchored, uniform-weight 2D local map using matched neighbours:
`F = sum(r_j1 r_j0^T) inverse(sum(r_j0 r_j0^T))`.
The scalar is `log(sqrt(lambda_max(F^T F))) / abs(t1-t0)`; negative values
for contracting maps are retained. Direction and positive duration are separate.
This is a finite-time fit to recorded particle motion, not an asymptotic exponent
or a velocity-integrated flow map. Particle shifting may separate sample motion
from material transport.

Require at least three matched neighbours, positive spatial rank, Gram-matrix
condition <= 1e6, finite input and nonzero physical-time duration. Relative residual
is `sqrt(sum(|F r0-r1|^2)/sum(|r1|^2))`. The local chart masks residual > 0.25.
The purple ellipse is the fitted image of a circle with the initial RMS radius;
it is a local fit visualization, not a fitted free-surface contour. Poor residual
fits are not drawn. 3D UID tracks are supported; deformation fits remain 2D.

## Spatial maps and ridge candidates

**Spatial FTLE map** opens a separate analysis view. Choose start/end frame,
32/64/128 longest-side sampling, radius, 3–64 neighbours and residual threshold.
Backward horizons are supported. A sparse cell index locates the closest recorded
fluid center to each initial raster point, then fits its nearest neighbours within
the chosen radius. Cells are located at t0. This is a raster sampled from material
centers, not SPH interpolation of a flow map at the raster coordinates. A center
must lie within both the search radius and 1.5 raster-cell diagonals. Masks expose
unavailable/ill-conditioned/non-affine regions, not zeros.

Progress is published in batches; 128 cells per worker job lets foreground work
run between batches. One endpoint/index context is retained. The reference path
limits each endpoint to 300K particles and each batch to 2M candidate visits;
pathological requests fail explicitly. Radius must be >= 1e-6 of the domain span.
This map is CPU work in the reader worker; the map display uses Canvas2D.

Hover reveals UID, matched count, residual and condition. Click a sampled center
to select its UID at t0 in the main viewer. JSON export includes values, masks as
nulls, quality arrays, identities, source name/id, frame parameters, physical times,
bounds, algorithm and coordinate convention. It identifies partial exports with a
completion flag. Source id is a viewer identity, not a cryptographic content digest.
Importing analysis JSON and retaining analysis definitions across refresh are not
implemented.

Optional mint ridge candidates mark samples above a threshold that are a local
maximum along either raster axis, requiring four finite adjacent cells. This is an
explicit simple scalar criterion, not rotation-invariant ridge extraction, a
variational/geodesic LCS method or proof of material coherence. Full LCS validation,
unsteady velocity-integrated flow maps and GPU deformation kernels remain future
work.

## Evidence and regeneration

`npm test` includes analytic translation/rotation/stretch/contraction/shear,
irregular and backward time intervals, periodic multi-box travel, row shuffling,
exact large IDs, gaps, duplicate UIDs, rank loss, residual masks and ridge criteria.
Reader scheduling checks verify foreground priority, queued cancellation and closure.

`node --import tsx examples/check-material.ts` checks all three bundled recordings
at 64 longest-side samples, compares valid samples with an independent brute-force
neighbour selection and reports runtime/quality counts. On the current machine,
full-horizon 64-grid map checks including 6–16 brute-force oracles took ~152 ms
(random), ~62 ms (slosh) and ~735 ms (KHH). These are Node CPU checks, not browser
FPS measurements. Oracle absolute errors were <= 1.5e-8.

Long-horizon default residual masks retained 126/4096 random cells, 6/2368 sloshing
cells and 1944/4096 KHH cells. This is a limitation of the local affine estimator
at those horizons, not a reason to fill gaps. Shorter horizons, sampling convergence
and neighbour sensitivity should accompany physical interpretation.

Browser verification: KHH capture, frozen identity counts while seeking, linked
FTLE chart, map generation/quality masks, ridge toggle, map-to-particle selection,
JSON export, cancellation, and LIC/settings restore. Evidence and logs belong in
`../warpSPHDevelopment/remote/material-flow-20261017/`, outside Git.
