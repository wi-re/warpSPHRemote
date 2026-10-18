# Kolmogorov first-frame stall

## Cause

A daemon-launched `kolmogorov`, deltaSPH, nx=512 run with launch-paused,
video armed and diagnostic recording enabled initialized 262,144 particles,
then waited indefinitely for its first live frame. Particle recording was off.

The viewer configuration path called the solver's checkpoint exporters. Those
exporters serialize boundary-condition functions with dill, capturing the
Kolmogorov CPU noise interpolator inside the forcing closure. The resulting
configuration was 5,776,949 bytes, exceeding the daemon configuration endpoint's
1 MiB limit. The transfer worker retried HTTP 400 responses continuously, hiding
the error and starving/discarding queued frame work. This was independent of
the 128 MiB particle snapshot budget.

## Change

Configuration inspection traverses declared dataclass fields, parameter mappings,
enums and small numerical values. It describes callables by qualified name,
never serializes their code/closures, and summarizes large arrays by shape and
dtype without copying their values. Cycles, depth, collection size, strings and
node counts are bounded. This descriptive document is for inspection, not a
restart checkpoint; full solver checkpoints keep their existing semantics.

Configuration upload failures are handled independently of frames and history.
Permanent HTTP 4xx failures stop retrying and publish a status message. Temporary
transport/server failures retry with at least two seconds between attempts.
A rejected configuration cannot discard the frame in the same transfer batch.
Successful retries clear their configuration warning.

## Verification and regeneration

With the installed real Warp/CUDA solver, the same nx=512 run produced a
6,389-byte configuration and a 6,291,824-byte dynamic snapshot. Its video-ready
preview arrived at step 0/time 0 while paused. Explicitly disarming video and
resuming advanced two steps to t=0.001 and completed normally. Video is disarmed
only by the reproduction, which has no browser to provide render ACKs.

From the repository root, using a Python environment with the simulator installed:

```sh
PYTHONPATH=python /path/to/warp/python examples/check_kolmogorov_startup.py \
  --python /path/to/warp/python \
  --output /tmp/warpsph-kolmogorov-FRESH
PYTHONPATH=python /path/to/warp/python -m pytest -q
```

The output must be a fresh directory. The reproduction starts/stops only its own
private daemon and worker, never the user's daemon. Generated evidence from this
verification is outside the checkout under
`warpSPHDevelopment/remote/kolmogorov-startup-20261018/`.

Workers already running keep their imported adapter. Stop and relaunch an affected
stuck run after updating the editable installation; an unchanged daemon can launch
the corrected worker, so a daemon restart is unnecessary for this fix.
