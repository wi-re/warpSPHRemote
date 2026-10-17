# Trajectory viewer verification

Verified locally on 2026-10-17. This is an initial recorded-particle viewer, not
completion of the longer visualization roadmap.

## Automated checks

- Ten Python checks (also passed in the isolated Python 3.14 environment with Torch absent) cover numerical frame ordering, recorded time, exact int64
  identity, dynamic density overriding initial metadata, rejection of changed
  populations with stale metadata, missing quantities, NPZ measurement times,
  explicit frame-index fallback, nonfinite positions, nested state layouts,
  aligned binary encoding, and loopback HTTP round trips/origin restrictions.
- Twenty-four TypeScript checks cover browser HDF5 frame slicing (gzip chunks), NPZ
  numeric parsing and ordering, browser analytical sources, pressure interpolation
  and dry-region gaps, and chart frame-index mapping, as well as fluid-only and logarithmic limits, constant and
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

- WebGL2 only; WebGPU and worker-side rendering/GPU upload are not yet implemented.
  File decoding, diagnostic scans, and pressure histories run in workers. Display
  preparation and GPU upload still use the main thread and can interrupt interaction.
- 2D grids and instantaneous streamlines are implemented. 3D slices/volumes,
  LIC, surface reconstruction, LCS, linked panels and numerical spatial axis ticks
  remain future work.
- Float32 display buffers limit coordinate/value precision; source diagnostics
  use float64 accumulation. Large UID probing remains exact, while UID coloring
  is approximate. UID traces use exact identities across frames; there is no multi-particle
  material-neighbourhood analysis or picking acceleration structure. Probing scans projected particles and has a 10-pixel
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
  distributable Python wheel yet. One browser-local file copy and its frame/field can now be restored. Other
  sources, probes, trace definitions and rendering settings remain session-local.

## Static browser milestone

The production build was also served under `/warpSPHRemote/` with Python's plain
static HTTP server and **no API service**. The browser opened a local 100,000-
particle HDF5 recording through its real file chooser and rendered it, confirming
WORKERFS access and subpath worker loading. The built-in pressure field supports
current-point sampling and complete histories without Python.

See [browser formats and limitations](BROWSER_FILES.md). The app's browser sources
are the default; Python API mode now requires `?service=1`. The local simulator
repositories are unmodified. The optional demo generator requires their environment
only to generate recordings, never to use or develop the viewer.

The static probe UI generated all 121 analytical samples. Clicking sample 60
(t=3) selected recorded index 60 (frame 61), and the current pressure updated to
0.20079. A real KHH file with 65,536 particles and 161 compressed frames also
opened through the static picker; seeking the final frame and changing to
density worked. Browser console checks returned no warnings/errors. Pressure
histories retained gaps after particles left a fixed probe's sampling region.

GitHub Pages was enabled with HTTPS and deployed via the committed workflow.
Both CI and an explicitly dispatched Pages workflow passed for commit b4fb4b5.
The public `https://fluids.dev/warpSPHRemote/` page loaded its analytical source.

Periodic mapping tests cover negative coordinates, multiple box crossings, mixed
periodicity and preservation of input coordinates. Trace tests follow exact UIDs
above 2^53 across row reordering, retain original unwrapped positions, and break
missing-ID and seam segments. HDF5 domain tests cover stacked datasets and native
nested config list attributes; pressure tests cover minimum-image queries.

In the static browser build, picking KHH UID 33151 at recorded frame index 80
retained its raw X=-0.50141 while displaying it in the periodic unit box. A
10-past / 30-future window produced 41 recorded positions. Stepping retained the
target UID and recentered the window; toggling wrapped/unwrapped views remapped
the scene without changing its scalar values. No console warnings/errors were
returned during these checks. The trace uses the available recorded sample rate,
not hidden simulator steps.

## Retention, energies and reconstructed fields

The production build was served on plain static HTTP under a repository subpath,
without an API server. In the Chromium browser:

- The analytical 2D field displayed a 256² scalar raster and 50,632 instantaneous
  streamline segments, with no returned console warnings/errors.
- The real energy-enabled KHH recording (65,536 particles / 161 frames) opened,
  rendered a reconstructed field and streamlines, and displayed internal energy
  3.75194 and total energy 3.9094 at t=2.0003.
- After “Saved for refresh”, reloading reopened that recording at index 80
  (frame 81), with density still selected, without another file picker. The
  renderer mode reset to particles as designed; view-style persistence is separate.

Numerical tests cover mass-weighted fluid energies, missing/invalid energy data,
constant reconstruction, particle-volume weighting, variable cutoff support,
vector-before-magnitude interpolation, dry masks, periodic splats without source
mutation, uniform-flow and rotating streamlines, masked stopping and seam splits.
The IndexedDB adapter test checks byte-exact copies, replacement and forgetting;
the real-browser reload is the persistence integration check. Python energy
reduction is also covered. These checks do not establish cross-browser storage
quotas or WebGPU performance: current compute is in the reader worker, while
raster/line drawing is WebGL2. See [format/limitations](BROWSER_FILES.md) and
[the planned compute layer](ROADMAP.md).

Disposable evidence for this iteration is under
`/tmp/warpSPHDevelopment/remote/fields-session-20261017/`; final captures can be
preserved under a distinct shared development archive directory. No generated
recording, raster, log or production bundle is committed.

A picked fixed-position streamline seed also remained active after stepping from
KHH index 80 to 81 (798 spatial line segments), independently of the temporal UID
trace. The real “Forget saved recording” button removed the browser copy: after
refresh the app returned to the analytical source and no KHH recording was
registered. The browser returned no console warnings/errors in these checks.
