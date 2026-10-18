# Buffered live monitoring and viewport video

Normal monitoring keeps one owned CPU snapshot at a completed solver boundary.
Only that consistent copy (including GPU→CPU synchronization) belongs to the
integrator thread. Finite checks, static revision hashing, bounds, binary packet
encoding and publication run on a separate transfer worker. Status, pause/resume,
stop and resource sampling have their own control worker, so a slow upload does
not occupy the control connection. The daemon serves its immutable packet outside
its registry lock. No historical queue grows behind a slow viewer.

The next capture requires the previous packet's viewer ACK and a configurable
minimum wall interval (default 0.5 seconds, zero adds no interval). Pause updates
stops capture/download, retaining the current displayed frame and control lease;
Pause simulation independently holds the integrator. Resume updates fetches the
held packet or next eligible state. A paused integrator still avoids reconstructing
identical state boundaries. Recording remains opt-in.

The metrics distinguish state→CPU copy, background encoding, adapter→daemon
publication and daemon→viewer download bytes/time/rate. Step throughput measures
completed boundaries in wall time, excluding deliberate pause/capture holds. It
is not a CUDA kernel profile. A slow network download alone does not establish
that it was limiting the solver; copying GPU state can still introduce a visible
synchronization cost. GPU memory and host memory budgets still matter.

## Export video

Use **Export video** above the viewport. A local trajectory supports first/last
frame and stride; the next read/reconstruction waits for the previous rendered
frame to be encoded. Live capture accepts a simulation-time interval and requires
both an updated daemon and a producer advertising synchronized video support.
It samples the first completed step at or beyond the requested time, rather than
modifying the numerical integrator's timestep. Video fps controls presentation
timestamps, independent of network, reconstruction and encoding delays.

Each frame is rendered explicitly, composed with a title, quantity/mapping,
time, available dt/scheme/kernel/integrator, particle count, color bar and camera
axes, and encoded with WebCodecs VP8. Metadata bands sit outside the scene pixels;
DOM buttons, picker controls and surrounding GUI are excluded. The encoder ACK
follows actual encoder output. The solver waits at due boundaries until that ACK.
Finish & save video drains the last encode/ACK, releases video mode and downloads
WebM. Normal completion forces delivery of a final state even between video frame
times, waits for its render ACK, then publishes completion; the viewer finalizes
and downloads automatically. Stop/failure saves the encoded portion available.

A disappearing viewer in unrecorded video mode leaves a safe-boundary capture
hold, including across producer re-registration after daemon restart. Reconnect
and start/resume video capture or use **Release video capture hold**. Taking over
an old viewer never silently releases this hold. Explicit Stop remains available.
When an exported trajectory exists, loss of the viewer releases the video hold;
the solver continues writing the optional recording for later offline export.
The lease detects an otherwise silent dropout within 20 seconds. Browser reload
loses the in-memory encoder/file; it does not release an unrecorded solver's hold.

Initial limitations: VP8/WebM, no audio, and a browser with WebCodecs VideoEncoder
support is required (feature/configuration checked before activating live mode).
The output resolution follows the initial viewport plus metadata bands and stays
fixed for the export. Background tabs can progress more slowly. Compressed chunks
are held in browser memory until packaged/downloaded, so very long exports need
sufficient RAM; raw image frames are not accumulated. No arbitrary capture timeout
resumes an unrecorded solver. A complete raw recording remains the reliable way
to regenerate a video after closing/crashing the browser.

## Read-only setup inspection

The left panel's **Inspect simulation configuration** fetches a producer-supplied
fixed setup once per run: requested case configuration, resolved run spec,
simulation config and solver config. Current adaptive dt remains live telemetry.
It is authenticated, read-only, bounded to 1 MiB, and does not expose edits or
arbitrary filesystem reads. Generic adapters without a resolved warpSPH context
advertise a labelled minimal setup. Configurations are not retransmitted with
every frame/status update.

## Verification and regeneration

```bash
npm test
npm run build
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/python -m pytest tests -q
# Synthetic browser fixture; choose a fresh output path, no simulator required:
PYTHONPATH=python python examples/live_controls_fixture.py \
  --output /tmp/warpSPHDevelopment/remote/new-video-check \
  --origin http://127.0.0.1:5173 --finish-on-file
# Connect to http://127.0.0.1:18767 with browser-fixture-token.
# Begin live video, then create output/finish.request to exercise final handoff.
# The fixture leaves its daemon up for 30 seconds after completion.
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/python \
  examples/check_daemon_recovery.py --python /path/to/warp/python \
  --output /tmp/warpSPHDevelopment/remote/new-real-setup-check
```

`tests/test_buffering.py` deliberately stalls publication for 1.6 seconds,
checks >100 integrator steps, independent pause/resume, ownership of copied arrays
and one-buffer backpressure. `tests/test_video_capture.py` checks render ACK gates,
frame spacing, final off-interval capture, recorded/unrecorded dropout behavior,
setup retrieval and validation. `tests/video.test.ts` optionally uses FFmpeg and
ffprobe to independently decode/count/seek muxed VP8, including clusters beyond
32 seconds. Without those tools only that interoperability check is skipped.

The 2026-10-18 browser check decoded a 13-frame trajectory export and a 21-frame
live export at 30 fps; the live final frame matched the completed solver time.
The transfer-pause check held the scene while another 1,000 steps completed. The
real 32² TGV check returned the full resolved configuration, survived crash and
graceful daemon restart while paused, resumed, and stopped through the companion.
Generated videos, screenshots, logs and JSON evidence live outside the repository
under `warpSPHDevelopment/remote/buffered-video-20261018/`.

Primary format/API references: [WebCodecs](https://w3c.github.io/webcodecs/)
and [WebM container guidelines](https://www.webmproject.org/docs/container/).
