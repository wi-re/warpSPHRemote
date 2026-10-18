# Live performance tracker

The left inspector shows producer status separately from the displayed frame:
step index (the solver's original, zero-based value), current simulated time,
Δt, recent wall milliseconds per completed step, an estimated remaining duration
and finish time. Hardware/status polling never changes a presentation revision
or requests reconstruction of an unchanged paused frame.

## Timing and forecasts

The adapter samples at its existing roughly 0.5-second metadata boundary, using
completed step-count and simulated-time differences over about five active
seconds. Initial compilation is excluded because there is no preceding completed
boundary. Output/capture and runner overhead are included in wall throughput;
this is not CUDA kernel time and needs no additional per-step GPU synchronization.
Deliberate pause time is subtracted. Repeated paused heartbeats preserve the last
measurement. An explicit step limit takes priority; otherwise the resolved case
time limit and measured simulated-time throughput determine remaining time.
The estimate follows recent behavior, so adaptive timesteps or changing workload
can change it. Pausing hides the finish timestamp and preserves the remaining
active duration. Missing limits, zero progress, terminal runs or stale heartbeats
have no forecast. Forecasts use local receipt time rather than assuming that the
browser and simulation machine have synchronized clocks.

## Hardware

The publisher I/O thread samples at most once per two seconds. Linux `/proc`
provides process resident RAM and system used/total RAM. Optional `nvidia-smi`
provides GPU counters, with one-second timeouts per query. There are no added
Python dependencies. Unsupported/missing counters remain unavailable, never
zero-filled. RAM counters currently require Linux; GPU counters require NVIDIA's
CLI. Other vendors/native OS memory APIs can be added behind the sampler.

GPUs are matched by simulation PID and physical GPU UUID, not CUDA ordinal.
This avoids misattribution under `CUDA_VISIBLE_DEVICES`; multiple attributed
GPUs are listed separately. Process VRAM is distinct from device-wide used/total
VRAM. Utilization, power and temperature cover the whole device, including any
other workloads. Driver restrictions, WSL/container PID visibility, MIG or MPS
can prevent process attribution; the panel explains when no GPU is attributed.
No viewer-side GPU information is substituted for simulation hardware.

Registration negotiates the telemetry capability. New adapters remain usable
against older daemons without sending unknown status fields. Older adapters
continue to display live frames and transfer metrics but cannot retroactively
provide producer counters. Restart the companion and launch a simulation with
the updated adapter to enable the full tracker; running simulations are not
restarted by a website update.

## Download measurements

Each received frame records actual WPR1 response-body bytes, download duration,
effective decimal MB/s and cumulative bytes for this attachment. A static
revision's identity/mass payload counts only when fetched; cached static arrays
still contribute to resident frame size but not network bytes. Duration covers
requests through complete body receipt (including server/HTTP latency), and
excludes decoding, grid computation, rendering, and empty snapshot polls. HTTP
headers and transport framing are not counted. The update interval includes
capture, polling, transport and display acknowledgement backpressure; it is not
the solver timestep. The last-update age continues increasing while paused.

## Presets

The sequential/logarithmic velocity presets retain their `speed`/`speed-log`
identifiers for existing URLs and saved settings, and display “Velocity”.
While a new quantity/grid is pending, the renderer and legend retain the old
quantity and color mapping. Layout effects commit the completed presentation
and mapping before the browser paints; settings remain editable while loading.

## Regeneration and verification

```sh
npm test
npm run build
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/bin/python -m pytest tests -q
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 \
  XDG_STATE_HOME=/tmp/warpsph-metrics-private-state \
  /path/to/warp/bin/python examples/check_live_metrics.py \
  --python /path/to/warp/bin/python --output /tmp/FRESH-metrics-check
```

The real-solver check requires NVIDIA GPU attribution. It creates its own daemon,
runs a small TGV case without recording, checks timing/resources, live bytes,
pause stability and resume, then stops only its own processes. Browser checks
can use `examples/live_controls_fixture.py` (CPU-only synthetic) or
`examples/auto_monitor_fixture.py` with a real TGV launch. Development origins
5173/5174 are already permitted; keep generated outputs outside this checkout.

Verified on 2026-10-18: 109 browser/data tests, 89 Python tests and a real NVIDIA
TGV run. In the real check, step throughput stayed around 9 ms across pause /
resume; PID-attributed VRAM, RAM, utilization, power and temperature were present.
The first 1,024-particle frame downloaded 29,096 dynamic and 12,560 static bytes.
Subsequent static reuse, unchanged paused snapshots and default recording-off
behavior passed. Browser checks additionally cover real 4,096-particle TGV
hardware display, transfer measurements and quantity/palette transitions.
