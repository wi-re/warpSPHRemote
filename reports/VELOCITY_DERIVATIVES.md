# Normalized velocity divergence and vorticity

2026-10-17. Field view → Grid quantity offers **Velocity divergence** and signed
**Vorticity · out of plane**, alongside the recorded scalar/vector quantity.
These use recorded 2D velocity; unavailable velocity disables the choices.

## Operator contract

For coverage `C(x) = Σ Vj W(x-xj,hj)` and reconstructed velocity
`vbar(x) = Σ Vj vj Wj / C`, the implemented derivative is

`∂b vbar_a = Σ Vj (vj_a - vbar_a) ∂b Wj / C`.

Divergence is `∂x u + ∂y v`; positive out-of-plane vorticity is `∂x v - ∂y u`.
The shader uses analytic Wendland C2/C4 derivatives with the same compact cutoff
supports and volume weights as the reconstruction. In 2D, `dk/dq / q` is
`-20(1-q)^3` for C2 and `-(56/3)(5q+1)(1-q)^5` for C4. Cancelling q analytically
avoids division by zero at a particle center; the gradient there is zero.

This is the derivative of a **Shepard-normalized viewer field**, not the core's
uncorrected/difference/symmetric particle operator, CRK, or renormalized solver
divergence. It does not enforce incompressibility or linear consistency, and
free-surface or poorly sampled regions can have substantial reconstruction error.
Units are stored velocity units divided by stored length units. No EOS, boundary
extension or physical-unit conversion is inferred.

Kind-0 fluid, variable supports, periodic minimum-image distances and coverage
thresholds follow the existing grid contract. Any invalid contributing velocity
masks both derivative and velocity. Invalid unrelated particle color fields do
not mask velocity derivatives. Dry cells stay transparent. Derivative color ranges
are symmetric about zero in Auto linear/symlog mode. Fixed ranges remain explicit;
log mode still excludes nonpositive samples. Choosing a derivative starts with
linear scaling and the diverging Cool/warm palette. Particle overlays are neutral
so their recorded values are not misrepresented by a derivative colorbar.

CPU uses f64 scatter sums and the quotient rule. GPU reconstructs an anchored mean,
then runs one additional gather pass over the already compacted cells. It preserves
the anchor and relative mean separately in the existing result buffer before
subtracting, avoiding a large uniform offset in the derivative accumulation.
No additional readback, adjacency construction or GPU buffer allocation is needed.
Interpolation-only requests skip the derivative pass. CPU fallback remains active.

## Validation and precision

45 normal tests cover interpolation, analytic flows, independent point finite
differences, velocity masks, presentation identity, exact UID selection, storage
and the three shipped demos. Six GPU scans and 61 real GPU/CPU cases passed through
Dawn on NVIDIA Blackwell / driver 610.43.02, using the production WGSL.

Manufactured uniform translation (including 1e6/-2e6 offsets), expansion, solid
rotation and shear check derivative signs and magnitudes. Interior affine-flow
checks allow 0.015 absolute error for the finite particle reconstruction; uniform
translation is zero within 1e-8. Independent central differences of direct point
interpolation agree with the CPU quotient-rule result within 2e-5 on irregular,
periodic, variable-support particles, including seam queries.

GPU comparisons require identical masks. For finite samples the acceptance bound
is `|GPU-CPU|/(1+|CPU|) <= 8e-5` for interpolation/velocity/coverage, and `3e-4` for
**derivative values only**. Spatial derivatives amplify f32 coordinate/support
roundoff and cancellation, especially near low coverage. The original interpolation
bound failed on the sloshing 512-grid derivative (about 8.7e-5); preserving the
mean residual improves translation stability but does not remove position
quantization. The explicit derivative bound is not a claim of f64 solver parity.
The worst recorded derivative scaled error was 1.453e-4; all masks agreed.

First/middle/last states of all three demos were compared at 128/256/512 resolution,
three warmed repetitions each. Selected 256-side medians, excluding file decoding,
streamlines and rendering but including packing/upload/index/compute/readback:

| Recording | Quantity | CPU | WebGPU complete |
|---|---|---:|---:|
| 16K random WCSPH | Divergence | 205.73 ms | 6.30 ms |
| 16K random WCSPH | Vorticity | 206.83 ms | 3.93 ms |
| Sloshing | Divergence | 22.16 ms | 1.70 ms |
| Sloshing | Vorticity | 22.35 ms | 1.60 ms |
| 65K KHH | Divergence | 243.14 ms | 11.11 ms |
| 65K KHH | Vorticity | 229.78 ms | 9.43 ms |

These are one machine's wall timings, not browser FPS. The embedded browser has no
WebGPU adapter, so browser checks exercised the CPU fallback and visible status;
Dawn executed the actual GPU path. Rendering remains WebGL2 and streamlines CPU.

## Reproduce

```bash
npm test
npm run test:gpu
npm run bench:gpu -- --derivatives
# Only the new KHH example:
npm run bench:gpu -- --derivatives --khh
npm run build
```

The browser route `?gpu-check=1` runs the same numerical cases in a worker on the
client adapter. Source originals are not needed for the benchmark: it reads the
committed example assets. Raw logs/captures stay outside Git under
`../warpSPHDevelopment/remote/velocity-ui-20261017/`; KHH packaging and its benchmark
are under `../warpSPHDevelopment/remote/khh-public-20261017/`.
