# Cooperative grid work, recoverable errors and frozen live states

## Changes (2026-10-18)

Grid reconstruction no longer rejects data because its estimated total candidate
work exceeds 160 million on WebGPU or 40 million on the CPU. The GPU still uses
compact cell ranges with every valid neighbour retained. It builds the index once
and submits query ranges targeting 16 million visits each. Reconstruction and
analytic derivatives use offset/count uniforms; the last partial range is guarded.
There is no per-cell neighbour truncation and no automatic resolution reduction.
Queue completion between ranges yields to the browser and gives cancellation a
safe boundary. A genuinely expensive individual query still has to complete; the
scheduling target does not pretend to be a strict GPU-time bound.

The CPU's original accumulation order is shared by a synchronous numerical
reference and an asynchronous cooperative driver. The latter yields every 65,536
candidate visits and during normalization. Live-source CPU work therefore no
longer monopolizes UI execution for the entire grid. Source-worker cancellation
messages abort the current reconstruction, freeing the serialized job queue for
the latest requested settings/frame. Stale results remain prohibited.

A failed grid computation now returns the numerical particle frame with a warning.
The scene offers Retry and Dismiss, keeping data and controls accessible. Successful
new requests clear the warning. While a job is still computing, the previous
complete view remains visible; particle fallback happens only after a real error.
The generic “Unable to display this frame / Open another trajectory” overlay is
removed. Device memory/buffer/precision constraints remain real failure conditions;
they are distinct from accepting a longer computation.

Paused publishers previously captured the identical safe boundary again after
every display acknowledgement. The publisher now records step, time and static
revision only after a successful upload. While those match, it holds the next
capture request. Failed uploads still retry; a new viewer lease still receives
the paused state because the daemon resets its static revision. The browser also
compares step/time and shared static revision objects before updating a LiveSource.
It acknowledges but does not render/reconstruct duplicates from an older publisher.
Pause status/control updates and explicit visualization-setting changes still work.

## Verification

- `npm test`: 108 passed, including batch coverage/tails, CPU cancellation/yielding
  above the old workload limit, recoverable reconstruction failures, stale-result
  rejection, and duplicate live-state detection.
- Python tests: 75 passed. The paused-producer regression acknowledges a frame,
  verifies the next request remains held, and detaches/reattaches while paused.
- Actual WGSL execution on NVIDIA Blackwell / Dawn webgpu 0.6.2: 78 checks passed,
  including million-cell constant-field, divergence and vorticity grids above the
  former candidate limit; in-flight cancellation and reuse of the same device.
- Actual nx=256 CRKSPH triple-point frame, 765,418 particles, grid 1024×439:
  582,598,656 conservative candidate visits, completed on the GPU in 138.5 ms
  (test hardware; excludes file acquisition). All 899,072 finite scalar/coverage
  samples matched the CPU reference within 1.15e-5 scaled error. Velocity samples
  were absent from this density-only extracted fixture, not fabricated.
- Full viewer: the same trajectory's 1024×439 CPU grid completed in about 5.4 s.
  The in-app browser has no WebGPU adapter, so explicit WebGPU selection exercised
  the warning, preserved all 765,418 particles, and Dismiss kept the source open.
- A separate synthetic live producer displayed a paused 256² CPU grid at snapshot
  2 with no repeated reconstruction/loading indicator. Resuming advanced it to
  snapshot 37 normally. Its daemon/producer were
  isolated from user simulations.

Generated screenshots, logs, fixture packets and checks are outside Git under
`warpSPHDevelopment/remote/particle-antialias-20261018/`.

## Reproduction

Run the existing browser app with a recorded trajectory or analytical demo; choose
a grid resolution and CPU/WebGPU backend. Existing live producers can be checked
with `examples/live_controls_fixture.py --output FRESH_EXTERNAL_DIRECTORY`.
Pause from the manager, watch live, choose Scalar grid, and verify the snapshot
sequence and loading indicator stop changing while paused. Resume to see new
snapshots. Only newly started Python publishers use the producer-side optimization;
the browser duplicate filter also supports already running older adapters.

Normal checks:

```bash
npm test
npm run build
npm run test:gpu
PYTHONPATH=python python -m pytest tests -q
```

For the real-frame numerical comparison, first use
`examples/prepare_particle_fixture.py` as described in
[particle filtering](PARTICLE_ANTIALIAS.md), then run:

```bash
npm run test:gpu -- --fixture /absolute/external/fixture --resolution 1024
```

This runs the production GPU kernels and CPU reference on identical extracted
numerical arrays without starting a simulation. Do not commit the generated frame,
recording, logs or screenshots. GPU execution requires an available device; the
ordinary Node tests do not substitute for actual shader validation.
