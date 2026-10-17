# Development evidence

Keep generated screenshots, videos, trajectories, raw measurements, profiles,
and run logs outside this source checkout. Use sibling
`warpSPHDevelopment/remote`, or `WARPSPH_DEVELOPMENT_ROOT/remote` when that shared
parent is relocated. Preserve significant historical evidence under distinct
run directories. `/tmp` is acceptable for disposable development evidence.

Commit written findings and limitations in `reports/`, reproduction code in
`examples/`, and automated checks in `tests/`. Do not commit recorded simulation
states, dependency directories, production bundles, or notebook outputs.

# Project boundary

This project starts with recorded-trajectory viewing. Keep the browser renderer
independent of the file adapter and simulator. Do not introduce simulator or
Jupyter/VTK runtime dependencies. Future live acquisition should implement the
frame-source contract rather than change rendering semantics.
