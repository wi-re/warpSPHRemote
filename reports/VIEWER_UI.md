# Viewer organization and interaction

2026-10-17. The desktop layout places current-frame information and numerical
summaries on the left, the plot/playback/charts in the middle, and visualization
controls on the right. The right panel can be hidden from the plot heading.
On smaller screens these regions flow without requiring a fixed desktop width.

The top-right current-trajectory button and Open trajectory both open a picker:

- Example recordings: WCSPH, sloshing and 256² CRKSPH KHH, with size/cadence and
  download state. Cached copies are identified before opening; downloads occur
  only after an explicit choice.
- Analytical demos: fixed-lattice 2D/3D Taylor–Green samples, labelled separately
  from advected solver recordings.
- On this device: last browser-local recording, open local sources, independently
  cached examples. Storage failures leave the upload route usable.
- Open file: HDF5 or NPZ files/folders, optional local-service path mode.

Viewer settings contains theme, compute backend, periodic display mapping, scene
background and last-file retention. Theme/backend/wrapping also persist in a small
localStorage preference record without an open file. Last-file view settings still
restore as before; example payloads have their own catalogue-versioned IndexedDB
entries. Theme affects the UI and chart contrast; scene background can be set
separately. Files are never uploaded. Neither menu needs a simulator installation.

## Particle picking and pressure probes

Use the plot cursor button or P to arm the picker. A click selects the closest
visible particle within the picking tolerance; dragging still pans/orbits. A
bottom-right card shows the exact UID, current row/position/value/kind, and a Trace
toggle. The trace window controls are in that card. The card follows exact UIDs
through reordered rows, playback and seeking. An absent UID is reported as absent;
it is never replaced by the old row's new occupant. Without UIDs, selection is
valid only for that one frame. Esc or the card's close button clears it.

The bottom diagnostic strip retains kinetic/internal/total energy and other
histories. Its Pressure probes tab now contains Add probe, fixed coordinates,
radius/method, current pressure and history generation next to the linked curve.
A picked particle can supply the probe's initial position; the probe remains a
fixed spatial point afterward. Clicking a curve sample seeks the recorded frame.
The chart area can be collapsed. Probe definitions and picked traces are still
session-local rather than newly persisted project state.

Derived grid quantities have their own completed-frame labels. Changing particle
coloring does not relabel vorticity as a recorded particle value. Neutral overlays
and a zero-centered signed range keep the scalar legend meaningful.

## Checks

Normal tests include saved/corrupt preference handling, exact large UID selection
across reordered/missing frames, source/frame matching for independent derived
fields, and existing atomic presentation cancellation. Browser verification covers
new layout, picker example/source choices, light/dark settings, derivative labels
and signed ranges, picked-particle trace toggling and frame changes, and pressure
creation/history generation from its bottom tab. KHH was loaded from its picker
entry with global energy diagnostics intact. Generated captures/logs belong under
`../warpSPHDevelopment/remote/velocity-ui-20261017/`, not in this checkout.

Regenerate with `npm ci`, `npm test`, `npm run build`, `npm run dev`; open the printed
URL and choose an example. GPU checks and their hardware limitations are documented
in [VELOCITY_DERIVATIVES.md](VELOCITY_DERIVATIVES.md).
