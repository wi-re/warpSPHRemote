# Compact controls, view links and scalar analysis

Iteration of 2026-10-17. Browser-only static hosting remains supported. There are
no simulator dependencies in the viewer; new files are curated solver exports.

## Controls and diagnostics

Appearance controls move into a left-panel disclosure. The right panel starts
with a recommended example view and share-link action. A single **Color mapping**
summary previews the palette, mapped quantity and scaling; expand for combined
mapping presets and individual quantity/component/palette/normalization/range
controls. Derived divergence/vorticity are in the mapped-quantity selector.
Reconstruction resolution/kernel/coverage have a separate disclosure. Streamlines
and LIC have independent toggles and expandable configuration. Collapsing a menu
changes no reconstruction state. Particle-only display still disables LIC work.

Fluid metrics have equal card styles, including kinetic, thermal and total energy
for compressible recordings. The small + opens the available-metric list; − on a
card removes it. Selecting a card opens its temporal chart. Selected cards also
define the metric chart tabs. Mass, volume, net momentum, momentum components,
mean pressure and density extrema are available alongside existing quantities.

New reductions are fluid-only. P = sum(m v), and net momentum is |P|, not
sum(m |v|). Volume is sum(m/rho); density and pressure means are particle means.
Missing or nonfinite required arrays yield unavailable metrics, not zeros. A 2D
recording has no recorded Z momentum. Existing recorded global diagnostics remain
authoritative; extra metrics use the stored numerical particle arrays. No EOS or
internal energy is inferred. Diagnostics scan one frame per job and yield to
foreground work. Metric selection and analysis preferences are saved with the
last-file view.

On narrow screens the main scene gets a minimum 420px height, and diagnostics
sit below the timeline with additional spacing. Panels remain in document flow.
The iteration is checked at a 390×844 viewport; temporary viewport overrides are
reset after testing.

## Recommended views and URLs

Newly opened examples receive recommended views: KHH selects the state closest
to t=2.6 with density, a linear diverging cool/warm map and a scalar grid. TGV,
decaying-flow and wake snapshots start at their final state with signed vorticity;
sloshing starts near t=2 with pressure. Remembered view settings take precedence
over defaults. **Recommended example view** reapplies the recommendation.
Explicit URL parameters take precedence over remembered settings. `preset=khh`
can force the named example recommendation independently of remembered choices.

Example:

`https://fluids.dev/warpSPHRemote/?demo=demo-khh-crksph-256&preset=khh`

Parameters (unknown/invalid values are ignored or bounded):

| Group | Parameters |
| --- | --- |
| Source/time | `demo` (catalogue ID or analytical demo ID), `preset`, `time`, zero-based `frame` |
| Mapping | `colorPreset`, `quantity`, `component`, `palette`, `scale`, `range`, `min`, `max` |
| Grid | `display=particles/grid/both`, `resolution=128/256/512`, `kernel=wendland2/wendland4`, `coverage`, `backend=auto/cpu/webgpu` |
| Flow | `streams=0/1`, `streamSeeds`, `seedMode=regular/picked`, `seedX`, `seedY`, `lic=0/1`, `licSteps`, `noiseSeed`, `contrast` |
| Appearance | `wrap`, `size`, `physical`, `boundaries`, `ghosts`, `referenceGrid`, `clipAxis`, `clip`, `theme` |
| Diagnostics | `metrics` (comma-separated keys), `chart`, `bins`, `fft=fft1/fft2`, `window=hann/none`, `mask=strict/zero`, `axis=x/y`, `slice=0..1` |

`quantity=vorticity` and `quantity=divergence` select derived grids. Other values
refer to recorded fields (`densities`, `pressures`, `velocities`, etc.). Mapping
preset IDs include density, pressure, speed, speed-log, vorticity, divergence and
thermal. `min/max` select a fixed range; `range=frame` explicitly returns to auto.

Share links serialize the current settings including chosen metrics/analysis.
Local files are not embedded or uploaded: the recipient must open the appropriate
file. Only recognized catalogue IDs can trigger demo downloads on page load.
Cached demos reopen locally. Arbitrary URL paths never become fetch targets.

## Histogram and spatial spectra

Color normalization/range affect rendering only; statistics use the recorded or
reconstructed quantity/component in its original numerical units, not log-colored
values.

The bottom **Histogram** tab uses finite mapped values from fluid particles or
covered grid cells, depending on the displayed mode. Categorical kinds/materials/
UIDs are excluded from scalar statistical analysis. Histogram bin counts sum to
the eligible sample count, including endpoints and constant-field handling.

The **Spectrum** tab offers a 1D spatial line FFT or a centered 2D FFT with a radial
shell sum. These analyze the mapped scalar after reconstruction; they are not a
vector kinetic-energy spectrum, nor a temporal FFT over trajectory frames.
Axes use cycles per source length unit, not angular wavenumber. The 1D line follows
X or Y at a selected transverse grid fraction. Radial values sum per-mode power
within frequency shells, rather than averaging it by mode count.

The finite-sample mean is subtracted. Choose a Hann window or no window for a
fully periodic field. Strict coverage rejects masked grids/lines. The explicitly
zero-masked option sets missing samples to zero after mean subtraction; geometry,
coverage and the window then affect the spectrum. The UI reports valid coverage,
window/mask policy, field, actual frame/time and total power. Analysis retains a
clearly labelled completed result while updating; playback pauses expensive
statistical updates until stopped.

Radix-2 transforms pad rectangular grids to powers of two while keeping physical
sample spacing. For N original samples and M padded FFT samples, per-mode power
is |F|²/(M N); one-sided 1D interior modes are doubled. Summed power equals the
mean square of the original windowed, masked signal, so padding does not dilute
it. There is no window-energy correction or synthetic extension across a solid.
The 2D image uses a log color range covering eight orders below its peak. FFTs
currently run on the reader worker CPU, with a 512² padded-cell limit.

## Verification

Tests cover direct complex DFT agreement, physical single-mode frequency,
Parseval normalization including rectangular zero padding, strict/zero masks,
mean removal, Hann windowing, histogram counts, fluid momentum/volume reductions,
URL parsing/round-trip and KHH defaults. Existing grid/trace/energy tests remain.
Browser checks cover the disclosures, configurable metrics, remembered settings,
URL-opened KHH, both statistical views, sharing and mobile spacing. Numerical
GPU checks on new recordings compare the existing normalized SPH derivatives
against CPU references; see the snapshot provenance report.

Run `npm test`, `npm run build`, `npm run dev`. For new recorded fixtures:
`npm run bench:gpu -- --snapshots --derivatives`. Evidence lives outside Git under
`../warpSPHDevelopment/remote/view-analysis-gallery-20261017/`.

## Picked-position streamline waiting state

Selecting picked-position seeds before a particle has been picked is an expected
interaction, not a frame error. The presentation keeps the scalar/particle field
and any LIC visible while suppressing only the unseeded streamline. It does not
fall back to regular seeds. The controls display a nonblocking waiting note and
activate the plot's particle picker; **Pick a seed** reactivates it after Escape.
Once a particle is selected, its fixed spatial seed is used immediately. Switching
back to regular seeds still generates the usual seed grid.

A regression test covers loading the field/LIC with no seed, then a valid picked
seed and regular seeds. Browser verification selected picked mode with no prior
selection on the 512² TGV, confirmed an unobstructed plot and active picker, then
clicked a particle and obtained 800 streamline segments without an error overlay.
Run `npm test`, `npm run build`, `npm run dev` to reproduce. Evidence is outside
Git under `../warpSPHDevelopment/remote/picked-streamline-waiting-20261017/`.
