# Particle filtering at small screen sizes

The nx=256 equal-mass triple-point lattice exposes a rendering defect: its dense
particles project to subpixel disks. The old shader discarded everything outside
the disk and faded only inward, shrinking its visible area. Small particles could
disappear or change brightness drastically with fractional-pixel camera motion.
Derivatives taken after an edge discard were also unreliable at tiny footprints.

The shader now pads billboard geometry by one framebuffer pixel and integrates
disk/pixel overlap for radii up to eight framebuffer pixels. The exact circular
quadrant integrals preserve the area of a subpixel disk. Larger particles use a
symmetric derivative-filtered signed-distance edge, avoiding cancellation between
large float32 integral values. Framebuffer pixel density and camera zoom enter the
footprint calculation; physical particle radii and recorded positions are unchanged.
No automatic point inflation, random jitter, grid interpolation or supersampling
is applied. Coplanar 2D particles blend without depth writes; 3D keeps sphere depth
and lighting, with defined depth on every fragment path.

## Verification (2026-10-18)

The browser harness renders the actual production material into a black 32×32
framebuffer, sums white coverage, and compares it with independent disk area πr².
It tests radii .1, .25, .5, 1, 1.5, 2 and 4 logical pixels over five subpixel
positions, at pixel ratios 1 and 2 (70 configurations). It allows .12 pixel²
absolute error for 8-bit framebuffer quantization. All checks passed. Previously
the .25-radius disk disappeared, and the .5-radius disk alternated between zero
and almost one pixel of coverage. At DPR1 the new .5-radius result differs from
πr² by at most .0068 pixel²; the .1-radius result differs by .000044 pixel².

A real 765,418-particle triple-point recording was compared at fit, quarter-pixel
pan and 2× zoom. An analytical 1,728-particle 3D lattice checked resolved sphere
appearance/occlusion. The full viewer opened the same existing trajectory.
`npm test` passed 103 tests; the production build and an additional TypeScript
check including the example passed. GPU throughput was not quantified: the
in-app browser's synchronous draw timing returned mostly zeros and is unsuitable
for a performance claim. Exact filtering adds fragment work, especially around
small disks; large-particle interiors use fast full-coverage paths.

Generated images, numerical checks, fixtures and logs are external evidence under
`warpSPHDevelopment/remote/particle-antialias-20261018/`.

## Reproduction

Run `npm run dev` and open:

```
http://127.0.0.1:5173/@fs/ABSOLUTE_CHECKOUT/examples/particle-antialias.html
```

This uses a deterministic dense lattice without data or simulator dependencies.
Add `?demo=3d` for the 3D view. “Run coverage checks” produces numerical results
using the actual fragment program. Pan and zoom controls exercise subpixel motion.
“Fit” restores the initial view and summary. Click the plot to verify selection.
The example is a development page, not part of the deployed application bundle.

For a real recording, extract an existing frame without modifying it:

```bash
PYTHONPATH=python python examples/prepare_particle_fixture.py \
  --recording /path/to/trajectory.h5 --index 4 \
  --output /path/to/warpSPHDevelopment/remote/NEW/fixture
```

Optional `--domain` accepts JSON min/max/periodic arrays when the native export
has no domain metadata. Serve that specific evidence directory through Vite's
`server.fs.allow` and append
`?fixture=/@fs/ABSOLUTE_EVIDENCE_DIRECTORY/fixture` to the example URL.
For a historical comparison, use the same fixture/view and restore the old
`web/src/renderer.ts` in a disposable checkout. Do not commit generated fixtures
or screenshots.

Pixel filtering reduces minification artifacts; it does not remove the actual
visible lattice of individually resolved particles. Very dense overlapping disks
still use ordinary alpha compositing, not an exact joint coverage integral.
