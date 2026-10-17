# Instantaneous line integral convolution

Implemented 2026-10-17. **Line integral convolution** in the right field controls
adds a texture over the selected scalar grid. It enables scalar-grid display if
necessary. Switching back to particles disables LIC so invisible LIC work cannot
slow particle-only playback. Length, contrast and noise seed are remembered with
the recording. Velocity data is required; it remains distinct from material tracks.

## Contract and backends

The deterministic CPU reference and WGSL use the same u32 hash at grid pixels,
bilinear noise sampling, normalized-velocity midpoint integration with a 0.6-cell
arc step, and a cosine convolution window over 4–32 steps in each direction.
Contrast remaps intensity around 0.5 and clips to [0,1]. Noise seed/pixel values
stay fixed in grid coordinates as frames change; changing grid bounds/resolution
changes the world-space noise mapping. No temporal advection is implied.

Both sample the reconstructed instantaneous velocity. Stop at invalid interpolation
stencils, nonperiodic boundaries and speeds below 1e-12; stagnant and dry origins
are masked. A conservative outer ring is masked on nonperiodic axes. Sampling
snaps sub-1e-4-cell roundoff at lattice lines before choosing the velocity stencil,
preventing CPU/f32 disagreement for exact-edge uniform flows. Periodic noise and
velocity wrap without drawing seam chords.

The worker-owned WebGPU backend runs the LIC compute kernel on its existing device
with reusable buffers; CPU remains a fallback. The current implementation uploads
the completed velocity grid, computes and reads back one intensity array for the
WebGL field renderer. It does not yet eliminate grid readback or share a WebGPU
render device. Explicit WebGPU errors remain errors; Auto may fall back and reports
which backend each stage used. Timings shown in the controls are separate from
reconstruction. CPU 512-grid LIC can take seconds; cancellation can drop queued
work but cannot interrupt a running synchronous reference kernel.

## Validation and measured limits

Normal tests check deterministic noise/settings, speed invariance, directional
smoothing in uniform flow, stagnation and dry/nonperiodic masks. Actual Dawn GPU
checks cover uniform, rotation, masked, stagnant and nonperiodic fields with exact
mask agreement and max absolute intensity error <= 2e-4 (observed <= 1.1e-5).

`npm run bench:gpu -- --lic` checks all shipped recordings at first/middle/last
states and 128/256/512 grids. Reconstruction retains its existing numerical gates.
LIC compares identical input velocity grids: finite/invalid masks must agree;
photometric intensity gates are RMS <= 0.001 and maximum <= 0.05. These are
separate from quantitative SPH field tolerances: LIC is a noise convolution, and
small f32 trajectory differences can change the stopping step at a mask boundary.

Initial strict max-only 0.001 checking exposed that boundary discontinuity on
sloshing; that failed evidence is preserved. Complete measurements found maximum
0.04339 / RMS 0.0002249 at slosh 512, with 7 of 80,995 finite samples differing
by > 0.001. At slosh 256 only 1/19,756 did so. Random and KHH stayed below 0.00043
maximum. All masks matched. Do not claim pointwise equivalence at free surfaces.

On NVIDIA Blackwell / driver 610.43.02, 256-grid LIC medians for three states were:

| Recording | CPU reference | GPU upload + compute + readback |
| --- | ---: | ---: |
| Random WCSPH | 1236 ms | 1.56 ms |
| Sloshing | 148 ms | 0.77 ms |
| KHH | 1531 ms | 3.41 ms |

These exclude HDF5 decode, SPH reconstruction and rendering, and are not browser
FPS claims. CUA's browser has no WebGPU adapter; its UI exercises the CPU fallback.
Actual WGSL execution and parity use the official Dawn Node runtime.

Run `npm test`, `npm run test:gpu`, `npm run bench:gpu -- --lic`, and `npm run build`.
If needed, expose the GPU device to the process rather than interpreting a sandbox
adapter failure as a kernel result. Evidence is kept under
`../warpSPHDevelopment/remote/material-flow-20261017/`, never in source control.
