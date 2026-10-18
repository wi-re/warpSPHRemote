# Capture diagnostics, recording views and capture planning

## Run and frame pipeline

The live performance panel separates producer activity from browser activity.
Producer states distinguish initialization, integration, a user pause, waiting
for a video viewer, and waiting for a video frame's render/encode acknowledgement.
Capture states distinguish the CPU copy, queued frame, configuration/history
work, encoding, publication, acknowledgement, the minimum capture interval,
waiting for a safe boundary, paused transfers and no attached viewer.

The daemon reports whether its immutable frame buffer is ready, its payload size
and age. Browser activity distinguishes requesting/downloading a frame,
preparing/reconstructing it, rendering/acknowledging it and video encoding.
The timings show the largest measured frame stage, not a claim of GPU profiling
or proof of causal solver contention. Ordinary background downloads do not hold
the solver. Synchronized video deliberately holds it at capture boundaries.

Pipeline metadata and initialized storage estimates are also retained in enabled
run-history samples. Existing hardware/resource sampling remains unchanged.
Stages are sampled observations; brief operations can occur between samples.
The producer and daemon must be restarted/upgraded to advertise the new metadata.
Legacy adapters keep working without these optional status fields.

## Recording view

Starting an encoder saves an owned snapshot of quantity/mapping, colors,
normalization/ranges, particle appearance, wrapping/clipping, grid reconstruction,
streamline/LIC settings and the viewport. Particle views preserve pan, zoom,
orientation, target and projection. 1D views preserve x/y extents and follow mode.
The viewport-heading **Restore recording view** action reapplies the settings
without seeking to the original time. This allows inspection of a paused run
and a return to the recording view before resuming.

The preset is kept in browser storage per source/run ID as well as in memory.
It is saved when recording starts, after the configured frame is ready. It is
not a portable server-side preset or an embedded video metadata track. A browser
reload still loses the in-memory encoder; an optional particle trajectory is the
way to regenerate the video. Probes and material-analysis tracking remain
independent analysis state, not part of this visualization preset.

## Video cadence and counts

Launch and live export offer simulated-time intervals or **every N completed
simulation steps**. Initial preparation holds still happen at step zero. Step
capture remains exact under variable/adaptive time stepping. All render gates,
viewer dropout rules and final-frame handoff apply to both modes. A final state
between cadence boundaries is captured once. The adapter translates the solver's
zero-based postStep index into completed-step counts; step zero is reserved for
the initialized state. Native trajectory filenames retain the solver's indices.

The setup and export dialogs show planned/estimated frame counts and playback
duration at the chosen output FPS. Recorded-file ranges include the final frame
when a stride misses it. Live counts using a time limit/current dt are explicitly
estimates: adaptive stepping, overshooting capture thresholds, stops and missing
future states can change the result. A known step limit permits an exact planned
count for step cadence. The live video status also shows the encoded frame count
and resulting playback duration so far.

## Particle trajectory storage

Trajectory recording stays opt-in. It also offers an explicit export-step stride.
For the current solver's trajectory writer, a requested simulated-time interval
is converted to a fixed step stride at initialization; the live panel exposes
that actual stride rather than implying exact uniform-time exports. The adapter
sets the requested explicit step stride at the initial-state boundary before the
runner initializes its writer. Launch metadata retains the requested cadence.

Before initialization, a range uses nominal nx/dimension and float32 fields.
After initialization, per-frame estimates use actual array sizes/dtypes for
position, velocity, density and case extraFields, with dataset overhead and an
initial-data allowance. No full particle values are copied to compute this.
The frame count follows the export stride and known step limit, or projects
remaining steps using the current dt for a time-limited run.

These are approximate trajectory-file sizes, not disk reservations. Geometry,
boundaries, variable particle counts, extra fields, rigid bodies and future dt
changes affect accuracy. Separate initial/final checkpoints and serialized case
configuration can add storage. Estimated sizes do not silently enable recording.

## Verification and regeneration

Generated evidence is outside Git at
`warpSPHDevelopment/remote/capture-diagnostics-20261018/`.

```sh
PYTHONPATH=python /path/to/warp/python -m pytest -q
npm test
npm run build
PYTHONPATH=python /path/to/warp/python examples/check_capture_pipeline.py \
  --python /path/to/warp/python --output /tmp/warpsph-capture-FRESH
```

The isolated real nx=32 Taylor–Green run captured video steps 0, 3, 6, 9, 11;
exported four trajectory frames with a four-step stride; and completed normally.
Its estimate was 294,928 bytes against a 205,320-byte trajectory. Tests also use
nonuniform dt to verify step cadence and final off-cadence capture.

For browser checks, serve the production build and run the existing
`examples/check_initial_video.py --browser` fixture with a fresh output directory.
The fixture advertises only a small Taylor–Green case on its own localhost port;
it never contacts/stops the user's daemon. The production viewer displayed the
initialized estimate and video frame/duration forecast, encoded a 10-frame live
VP8 video, and restored the saved grid view after inspection. The test browser
intermittently lost its localhost connection; the partial video remained savable.
Keep the test tab foregrounded for synchronized-video checks. Browser storage
quota failures leave the session's in-memory recording preset usable.

When stage metadata is absent, the viewer distinguishes a companion that needs
a restart, a run started with an older adapter, and a current adapter awaiting
its first status. These notices never claim that the simulation is stalled.
Restarting a companion is deliberately left to the user so active video capture
is not interrupted by a diagnostic UI update.
