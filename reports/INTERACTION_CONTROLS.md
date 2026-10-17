# Particle repicking and numeric interaction controls

2026-10-17. An active material neighbourhood now follows subsequent particle picks.
A new picked UID (or a new capture instant) cancels the previous acquisition,
captures neighbours at the displayed frame and generates the new material curve.
The existing generation/abort guards keep late results from replacing the new set.
Untrack ends this behavior; picking a particle afterwards only changes selection.
Blank-space clicks do not discard the active set. Explicit Track remains useful
for recapturing the same particle after changing neighbour settings.

The independent **Spatial FTLE map** action now sits in **Quantity analysis** on
the right, alongside Histogram/Spectrum. It opens at the current displayed frame
and requires neither a selected particle nor an active material set.

## Custom grid resolution

Ctrl-click (Command-click on macOS) the resolution selector to open an inline
numeric editor. Ctrl/Command+Enter while focused or the visible **Custom…** action
also opens it. Type or drag a value, then Apply / Enter. Invalid drafts never
change the running reconstruction. Presets remain available and the selector
shows the currently selected custom size.

The longest-side resolution accepts integers from 8 through 2048, including
non-powers of two. Validation is shared across grid reconstruction, URL parsing
and remembered settings. Custom dimensions retain physical aspect ratio and are
shared by CPU and WebGPU. Existing workload/device memory limits still apply.
Spatial spectra retain their independent 512² padded FFT limit, with inline
analysis feedback if the reconstructed grid is too large.

## Numeric dragging

Numeric fields for frame windows, material/FTLE settings, probe positions/radii,
LIC seed, fixed color limits and custom resolution have a separate **↕** handle.
Direct typing stays available. Drag up to increase, down to decrease. Faster
vertical movement and greater horizontal distance from the starting point
increase sensitivity. Shift reduces sensitivity tenfold. Pointer capture keeps
the interaction active outside the handle. Escape restores the starting value;
pointer cancellation also restores it. Dragged values respect numeric step and
bounds, including fractional steps. Keyboard users can focus the handle and use
Up/Down for one step or PageUp/PageDown for ten. Existing range sliders retain
their usual behavior.

## Verification and reproduction

Run `npm test`, `npm run build`, `npm run test:gpu`, and `npm run dev`.
New tests exercise drag direction, speed/distance acceleration, precision and
bounds, custom 173² reconstruction, settings/URL retention and rejected invalid
sizes. Real GPU/CPU comparison coverage now includes 173² for scalars, velocity,
divergence and vorticity with both kernels. All 79 tests and all 74 numerical
GPU cases plus six exact prefix-scan cases pass.

Browser reproduction: open KHH around t=2.6, start tracking UID 44902, then pick a
different particle. UID 16625 became the captured center with 25 UIDs and all
35 frames in the requested window; the curve and tracks changed accordingly.
Untrack, then pick again: the panel stays untracked. Ctrl-click resolution,
apply 173 and verify a 173×173 reconstruction. Dragging its handle changed the
draft 173→186 without applying until requested. No browser errors were reported.

Evidence remains outside Git under
`../warpSPHDevelopment/remote/interaction-controls-20261017/`.

## Categorical fields and periodic UID colors

UIDs/kinds/material categories remain particle-rendered. Grid options are disabled
with inline guidance instead of producing a blocking frame error. Previously
saved views or URLs requesting a categorical grid are normalized to an interactive
particle presentation; optional streamlines reconstruct velocity independently.
Selecting a continuous quantity re-enables grid display. Categorical values are
never silently averaged into fake IDs.

The **UIDs · full-range colors** mapping preset selects UIDs and Twilight with
**Color period = 0**: no wrapping, using the full fluid UID range with linear
normalization. A positive integer period (up to 1e9) repeats colors; setting it
back to zero restores the automatic or fixed range controls. The same behavior
applies to particle and grid shading. `colorPreset=uid-cyclic` remains compatible;
`scale=cyclic&period=0` explicitly disables wrapping in a shared URL. Saved settings
preserve zero and existing explicit positive periods. Applying the preset resets
the period to zero. With a positive period, integer UID modulo is computed before
float32 upload, including exact bigint UIDs above 2^53. This changes color only;
selection/identity and scalar analysis retain the original recorded arrays.
Tests include huge integer UIDs, periodic repeats, safe categorical presentation,
velocity overlays and settings. Initial verification passed 81 tests; GPU reconstruction
coverage remains 74 cases plus six exact prefix scans. Browser verification
switched density grid → UID periodic preset without alerts and confirmed that
continuous grid choices become unavailable while the particle scene stays usable.

The no-wrapping follow-up passed 88 TypeScript tests and the production build.
Browser verification on the 65,536-particle KHH recording switched the period
0 → 256 → 0, checking the full 0..65,535 range, explicit modulo range and restored
range controls without console errors. Evidence is retained outside the checkout
in `../warpSPHDevelopment/remote/uid-color-period-20261017/`.
