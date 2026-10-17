# Material analysis and LIC controls

2026-10-17. This supersedes the earlier bottom-tab placement of Histogram/Spectrum
in VIEW_PRESETS_AND_ANALYSIS.md. Numerical reconstruction and FTLE fitting are
unchanged.

## Starting and stopping a material curve

Open **Material motion → Pick a particle**, click a fluid particle in the scene,
then **Track neighbourhood** in that tab or the particle card. This captures a
fixed set of exact UIDs at the displayed frame and reads their recorded positions
within the past/future frame window. Before tracking starts, selecting a particle by itself does not
capture a material set. Once active, tracking follows new picks automatically. An empty panel now explains this workflow instead of
showing an empty graph. **Untrack** beside Track cancels pending work, removes
the captured tracks/ellipse and clears the curve. The selected particle remains.

RMS radius is the neighbours' RMS distance from the center. Local FTLE uses the
capture instant as the initial time, so it has a gap at that instant; rejected
fits also remain gaps. The curve's samples can seek the trajectory. Sparse
snapshots remain unsuitable for reconstructing unresolved temporal motion.

## Reading the FTLE map

The dialog now includes physical initial-coordinate axes, forward/backward
interval and duration, accepted-fit percentage, mask counts, a numerical color
legend, a distinct patterned mask, per-cell hover information and an explicit
explanation of missing regions. It starts at the current frame (or the captured
material frame), with a nearby end frame. A compact overview fits the window;
**Enlarge map** provides more detail. One-frame sources cannot open this analysis.

The layers are FTLE, fit residual (including rejected fits) and accepted-fit
coverage. A bright FTLE cell means stronger finite-time stretching. A patterned
cell is unavailable/untrusted, not zero stretching. The fit summary groups masked
cells by no sampled center, fewer than three matches, residual over the selected
limit, or other unavailable/unstable fits. These are display summaries of existing
fit outputs, not a new physical model. For KHH frames 27–37 at 32², 541 of 1,024
cells passed; all 483 rejected cells exceeded residual 0.25. Shortening the
interval can improve local-fit validity. Relaxing the limit merely admits less
reliable fits.

Full numerical color range is the default. Optional 95th-percentile clipping
improves contrast without changing values. Coverage/residual layers help explain
missing fits. Ridge candidates stay in a method-details disclosure and are not
represented as validated material LCS. Hover stretch factor is exp(FTLE × |Δt|),
using the same fitted deformation measure.

## Mapped quantity statistics and animated LIC

Histogram/Spectrum are independent toggles below Color mapping in the right
column. They no longer replace temporal diagnostics. They retain their scalar
units, coverage/window metadata and playback pause behavior. Existing
`chart=histogram/spectrum` links still open them. New links use `chart` for the
temporal diagnostic and `analysisView=histogram/spectrum/off` for quantity analysis;
both selections persist independently with the remembered file.

**Line integral convolution → Animate flow texture** adds a speed slider, stored
with the view and shareable via `licAnimate=0/1` and `licSpeed=1..20`. This is
bounded advection of the existing LIC texture along the frozen velocity field,
using normalized velocity direction, midpoint steps and two staggered cyclic
phases. Speed is visual (minimum grid cells per second), not simulation time or
physical velocity magnitude. It does not advect particles or the mapped scalar,
advance the timeline, reread a frame, reconstruct a grid, or recompute the LIC.
Rendering uses the existing WebGL scene even when reconstruction uses WebGPU.
It respects periodic boundaries and invalid velocity samples; unsupported traces
fall back to the static texture. Dry/stagnant cells retain the existing mask.
Animation stops when LIC/grid is hidden or the browser document is hidden.
Turning the animation off restores the static LIC. Render telemetry updates are
throttled during animation to avoid driving React at the render frame rate.

## Verification

Run `npm test`, `npm run build`, then `npm run dev`. Unit checks cover FTLE display
counts (including true zero and unfinished cells), independent diagnostic/analysis
persistence and URL parsing, and LIC animation preference bounds. Existing tests
continue to exercise the numerical algorithms.

Browser checks on the KHH recording cover starting a 25-UID material set, its time
curve, untracking to the empty state, right-column histogram/spectrum alongside
that curve, all FTLE layers and compact map, and shader compilation. On a paused
frame, two LIC-animation screenshots differed in 19,197 of 19,460 sampled scene
pixels; with animation off the same region had zero differences. The frame stayed
at 27/t=2.6002, and no shader/browser errors were reported. This is an interaction
check, not an animation-performance benchmark.

Generated screenshots and logs live outside Git in
`../warpSPHDevelopment/remote/material-analysis-ux-20261017/`.

Particle repicking, the FTLE action placement, custom grid dimensions and numeric
drag handles are detailed in [INTERACTION_CONTROLS.md](INTERACTION_CONTROLS.md).
