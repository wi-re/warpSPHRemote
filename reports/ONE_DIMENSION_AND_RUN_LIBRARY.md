# Native 1D viewing, durable runs and retained measurements

Implemented 2026-10-18. The viewer remains a static application. Localhost/SSH
forwarding is unchanged; no external listener or certificate setup is needed.

## Use 1D without a daemon

Open a native HDF5 trajectory or NPZ snapshots with **positions `[N,1]`**.
The browser selects a Canvas 2D profile viewport: the chosen quantity on the
vertical axis versus physical x on the horizontal axis. A one-component velocity
is signed; it is not replaced by speed magnitude. Samples are scatter points;
there is no implicit line across shocks or disconnected regions.

Picking preserves exact UID identity, and normal timeline/playback, field/mapping,
histograms, fixed probes, generic profiles, PNG and viewport video work with the
same frame-source contract. The profile has independent numerical x/y axes,
pan/zoom, Fit, and **Follow profile extents / Fixed profile axes**. Panning/zooming
switches to fixed axes. A quantity/component change refits. Supported color/file
preferences still restore normally; camera/axis bounds are not yet a portable
workspace. 2D reconstruction/LIC/FTLE and spatial UID trail overlays are not
presented as 1D operators.

Try [the browser-only 1D contraction fixture](https://fluids.dev/warpSPHRemote/?demo=demo-1d&frame=80)
under Analytical demos. It prescribes particle contraction and signed velocity;
it is a synthetic kinematic viewer fixture, not a Kidder/SPH validation solution.
It requires neither a file download nor Python.

### Physical bounds and changing domains

Computational domain/periodicity, observed sample extent and physical shell/wall
boundaries are distinct. The profile does not infer walls from extrema. With no
physical metadata it explicitly says so; sample extents still provide useful
following axes. Source positions are never rewritten.

Optional HDF5 arrays, outside particle-field groups:

- `/frameMetadata/physicalBounds [T,2,1]`: physical lower/upper boundary coordinates.
- `/frameMetadata/domainMin [T,D]`, `domainMax [T,D]`, `periodic [T,D]`: a complete
  per-frame computational domain. All three must be supplied together. Domain
  bounds must be finite and ordered; periodic flags are boolean/0/1.

The browser reader, Python reader and WPR1 optional frame metadata preserve these
channels separately. Physical-boundary markers are dashed. The 1D profile uses
per-frame domain metadata before initial source-domain metadata when periodic
mapping is requested. Fixed axes preserve the chosen view while boundaries move.
No automatic normalized/radial coordinate transform or analytical reference
curve is inferred from the case name.

The trusted Kidder adapter samples physical shell bounds from the installed
case's solution at actual snapshot times. Recorded-history requests use a numeric
model retained with the recording descriptor. On normal close, after the HDF5
writer is closed, the adapter also writes numeric `physicalBounds` at the file's
actual recorded timestamps, so downloading/opening the file needs no solver or
model evaluation in the browser. Failed geometry annotation cannot fail the solver.
Older recordings still open, with unavailable physical boundaries clearly labelled.
Driven boundary bands retain their recorded kinds; the viewer does not invent a
separate classification when none was exported.

## Live 1D cases

Update/restart the companion once and launch new simulations with the updated
adapter. Native 1D registered cases can now be advertised as available; 2D slab
presets remain distinct. Dynamically discovered 1D cases allow nx up to 16,384
(subject to their own solver validation). Cases use their installed schemas,
including Kidder's derived end time: the generic End time input is disabled and
the solver's `tauFraction`/initialization determines its resolved target.

Launch paused, initial previews, independent simulation/update pause, live/history
switching, auto-attachment and video ACK/final handoff use the existing contracts.
A live preview at t=0 does not imply that the solver's own trajectory writer stored
an initial frame; replay shows the frames actually exported.

## Durable run library

The companion persists run metadata, resolved configuration, recording descriptors,
and enabled measurements using SQLite transactions. It never stores live particle
snapshots in this library. Managed logs, launch specifications and newly generated
exports are also placed under the durable library's `runs/<id>/` tree.

Default location:

```text
$XDG_STATE_HOME/warpsph-remote/libraries/<runtime-identity>/
# XDG_STATE_HOME defaults to ~/.local/state
```

An explicit custom `--runtime /path/session` uses sibling `/path/session-library`
so removing the runtime descriptor does not remove the library. To select another
private data location, set this before starting the companion:

```bash
WARPSPH_REMOTE_DATA=/path/to/private/run-library warpsph-companion
```

The data directory must belong to the current OS user and have mode 0700; a new
one is created with that mode. Local pairing keeps its existing separate storage.
Finished entries/configuration/history return after daemon restart. An entry that
was active at shutdown is labelled **interrupted / waiting for producer** until
the existing adapter recovery re-registers it; loading a manifest never asserts
ownership of a stale PID or sends it a signal.

**Run history → Run report** inspects retained measurements/configuration and
recording size/location. **View history** still reads particle exports lazily.
**Forget entry** explicitly removes the manifest and diagnostic rows, after a UI
confirmation; it leaves particle files and logs on disk. The old 128-run session
cap is removed. There is no automatic export deletion, legacy-run reindex/import
or disk quota/retention scheduler. Existing pre-upgrade finished entries cannot
be reconstructed solely from a missing old registry; their files remain readable
through the normal local-file picker.

## Physical and performance diagnostics

In Run simulation enable **Record physical and performance diagnostics**.
Particle recording is a separate checkbox and stays off by default. Existing
Python launches can use:

```python
run_live(case, measurements=True, diagnostic_interval=0.01,
         store=False, plot=False, nx=256)
```

A diagnostic interval of 0 in the GUI means automatic: approximately 200 physical
samples over the resolved run duration, at actual completed boundaries. A positive
value selects simulation-time spacing. No interpolated samples are invented.
Final physical measurements are captured even between requested sample times.

Recorded physical reductions include available kinetic/internal/total energy,
mass, momentum components, mean density/pressure, and configured pressure probes.
They use recorded kind-0 fluid semantics. Reductions operate on solver arrays;
only scalar results are copied to CPU, not a full state. They still add reduction
and synchronization work, which is why the feature is opt-in.

Performance/resource samples are retained approximately once per wall second,
independently of viewer pulls. The existing resource collector refreshes roughly
every two seconds. Available counters include:

- Rolling active step throughput in ms/step and simulation-time throughput;
  state-copy, encoding and publication durations/bytes when capture occurs.
- Simulation-process resident RAM, separately from system used/total RAM.
- PID-attributed NVIDIA VRAM, separately from device-wide VRAM, utilization,
  power and temperature, with GPU identity and resource sample timestamp.

Step throughput is based on completed boundaries, excludes deliberate pause/video
holds and is not a CUDA kernel profile or a per-kernel time. Resource counters
may be absent; they are never replaced by zero. Shared GPU device counters cannot
be attributed exclusively to this simulation. Browser-only download/MB/s history
is not persisted by this producer recorder; those values remain in Live performance
while a viewer is attached.

### Pressure logging

For an enabled diagnostic run, add/configure probes under Pressure probes and
choose **Record configured probes for this run**. The producer then samples them
at the physical diagnostic cadence even with updates paused or the viewer gone.
The current probe coordinates are fixed in physical recorded coordinates; periodic
minimum-image distance, finite-radius nearest/IDW and dry gaps match the viewer
convention. No moving-wall transform is guessed.

Recorded probe definitions are immutable per ID. To change location/radius/method,
add a new probe instead of relabelling the old curve. Removed definitions remain
in the run metadata, so CSV probe-ID columns remain interpretable. Sending an
empty current list stops future probe sampling. Plotting-only probe changes do
not silently alter the producer's recording setup.

### Inspection and limits

Run report offers physical or elapsed-wall-time axes, selectable physical/resource
metrics, sample-based min/median/p95/max and complete CSV download. Click a plotted
sample to open the nearest available particle-history frame when that run has a
recording. Without particle recording, scalar histories remain useful but cannot
recreate spatial frames. Configuration inspection remains read-only.

Plots retain at most the latest 50,000 rows in browser memory; CSV fetches all
retained rows. Statistics describe that displayed sample set, not exact allocation
peaks or time-weighted GPU averages. Long CSV downloads still assemble in browser
memory; there is no streaming export sink yet. Samples use wall timestamps and
elapsed wall time; clock adjustments can affect the elapsed-wall axis.

The producer uses a bounded 1,024-sample queue and sends batches of at most 32.
Retries are idempotent; overflow increments the exported `omittedSamples` counter.
SQLite commits preserve a valid prefix across crashes. A recording I/O failure
reports a warning and backs off; it does not prevent pause/resume/stop. An abrupt
process kill can still lose pending samples. There is no promise of durable
particle-state recovery without an explicitly saved trajectory/checkpoint.

## Verification and reproduction

```bash
npm test
npm run build
PYTHONPATH=python python -m pytest tests -q
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/python \
  examples/check_1d_run_history.py --python /path/to/warp/python \
  --output /tmp/FRESH-1d-history-check
# Add --browser to keep only this fixture's private restored-run daemon available.
```

Tests cover native/stacked/NPZ 1D data, exact UIDs and signed values, physical and
changing computational bounds, persistent completed/paused runs, final numeric
geometry annotation, resource/physical CSV gaps, duplicate sample retries,
probe-definition retention and control operation when persistence fails.
Existing rendering/data, buffered transfer, video, pairing and recovery tests remain
part of the regression suite. No user daemon or simulation is contacted by the fixture.

The isolated real check ran CRKSPH Sod at nx=32 without particle recording and
Kidder at nx=32, tauFraction=0.8 with particle exports. Kidder completed 1,493 steps
to t≈0.0227346, shrinking its shell radii to about 60% of their initial values.
Both completed run records and measurements survived manager reconstruction;
Sod retained 11 rows and Kidder 202 in that check. Counts/timing are evidence for
this run, not guaranteed sampling rates or physics validation.

Browser verification opened actual 1D Kidder history and the exported local HDF5,
stepped the profile with signed negative velocity and physical boundary markers,
and exported a five-frame VP8 WebM independently decoded/count-checked by ffprobe.
Generated screenshots, videos, SQLite data, solver outputs and logs are outside
Git under the external development evidence directory or disposable `/tmp` runs.
