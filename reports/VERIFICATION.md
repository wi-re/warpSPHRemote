# Initial trajectory viewer verification

Verified locally on 2026-10-17. This is an initial recorded-particle viewer, not
completion of the longer visualization roadmap.

## Automated checks

- Nine Python checks (also passed in the isolated Python 3.14 environment with Torch absent) cover numerical frame ordering, recorded time, exact int64
  identity, dynamic density overriding initial metadata, rejection of changed
  populations with stale metadata, missing quantities, NPZ measurement times,
  explicit frame-index fallback, nonfinite positions, nested state layouts,
  aligned binary encoding, and loopback HTTP round trips/origin restrictions.
- Four TypeScript checks cover fluid-only and logarithmic limits, constant and
  invalid ranges, vector components/magnitudes, and binary decoding with exact
  IDs above JavaScript's safe-integer limit and truncated-array rejection. Diagnostic histories also preserve unloaded and invalid gaps instead of drawing interpolated lines through them.
- TypeScript compilation and the Vite production build pass. Vite warns that the
  scientific-rendering and Plotly bundles exceed its default 500 kB chunk advice;
  Plotly is loaded separately. This local application has no CDN dependency.

Commands: `pytest -q`, `npm test`, `npm run build`. The HTTP test needs permission
to bind a loopback socket when run in a restricted sandbox.

## Browser checks

The Codex in-app Chromium browser displayed the production build at 1280×720.
These are focused checks, not a cross-browser or exhaustive usability study.

- Opened the real Marrone NPZ sequence: 51 frames, 4,400 particles, including
  800 fluid particles. Stepped, played, paused, sought to the final frame,
  recolored with Inferno, and inspected a fluid particle's position and value.
- Opened the native sloshing HDF5 recording: 701 frames and 12,415 particles.
  Sought directly to its final time (7.0) and switched to density.
- Displayed the labelled 3D analytical Taylor–Green field and exercised clipping.
- Opened a separately generated four-frame HDF5 analytical fixture with 100,000
  3D particles through the local-path dialog. Displayed its field and a clipped
  portion. No browser console warnings or errors were returned during these
  checks. This is evidence of rendering, not a measured GPU throughput claim.
- Submitted a nonexistent recording path; the dialog reported the missing file
  without replacing the current source.

PNG export is implemented, but the automated browser download-event check timed
out, so saved-file delivery has not been confirmed. Export excludes the HTML
legend, overlays, and charts. Numerical color-range tests do not establish
pixel-perfect output across graphics drivers.

Screenshots and transient logs are outside Git under
`/home/lu26029/dev/warpSPHDevelopment/remote/trajectory-viewer-20261017-initial/`. See
[storage and reproduction](README.md). The original plotting and simulator
repositories were used read-only. Their recordings are not included here.

## Known limits

- WebGL2 only; WebGPU, workers for decoding/rendering, and background GPU upload
  are not yet implemented. Large frame preparation currently uses the browser
  main thread and can interrupt interaction.
- No SPH grid interpolation, volumes, streamlines, surface reconstruction, linked
  panels, or numerical spatial axis tick labels yet.
- Float32 display buffers limit coordinate/value precision; source diagnostics
  use float64 accumulation. Large UID probing remains exact, while UID coloring
  is approximate. There is no trajectory-wide identity tracking or picking
  acceleration structure. Probing scans projected particles and has a 10-pixel
  center-distance threshold; overlapping candidates are selected by screen
  distance, not frontmost sphere intersection.
- Shader symmetric-log scale is fixed at 1. Palette previews/colorbar gradients
  use representative stops, while the GPU uses the full 256-entry tables.
- The reference box is initial particle bounds, not necessarily the simulation
  domain. Camera refits are explicit during playback. Very dense physical
  particles can be subpixel.
- Columnar legacy HDF5 assumes initial combined metadata remains row-aligned.
  Changing counts with missing per-frame metadata fail explicitly; same-count
  unrecorded reordering cannot be detected. Only the first frame determines
  selectable field names; missing fields on later frames produce an error.
- Files must be finished recordings. Live capture, HDF5 concurrent writes,
  daemon discovery/autostart, simulation controls, static-field transport caching,
  and networking optimization are intentionally deferred.
- This preview is installed from source; frontend assets are not packaged in a
  distributable Python wheel yet. Browser settings/source registrations are
  session-local and are not restored after restarting or reloading the service.
