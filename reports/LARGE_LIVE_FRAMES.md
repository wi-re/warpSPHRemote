# Live triple-point attachment above 600,000 particles

## Failure and fix (2026-10-18)

The equal-mass triplePoint case at nx=256 with CRKSPH creates **765,418**
particles on the installed solver. The former publisher and packet validator
rejected shapes above 600,000, although its first full snapshot is only about
32.1 MiB. The solver kept running and exporting. The publisher marked the capture
request consumed before validation, so it never retried; the browser continued
showing “waiting for startup” while the actual error was buried in run metadata.

Particle counts are now bounded by actual packet sizes and descriptors rather
than that arbitrary cap. The daemon advertises its configurable byte budget
(`--max-snapshot-mib`, default 128); both capture preparation and upload enforce
it, including static revisions. The WPR1 descriptor validator still checks shapes,
byte counts, offsets, alignment, dtype and packet extents. It no longer imposes a
separate particle-count cap, including on recorded-history packets.

Validation/encoding failures leave the request outstanding. The step-boundary
adapter throttles retries to at most twice a second, keeps control/status and
history service working, and clears its capture warning on recovery. The closed
picker's connection notice uses current run metadata and shows the capture reason
or distinguishes startup from waiting for the first live frame. A failure does
not introduce a blocking modal or stop the solver.

## Reproduction

Run in a working warpSPH Python environment, from this repository:

```bash
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 python examples/check_large_live.py \
  --python /path/to/warp/bin/python \
  --output /path/to/warpSPHDevelopment/remote/triplepoint-live-NEW
```

This creates an isolated loopback daemon on an ephemeral port, launches only its
own nx=256 CRKSPH case with opt-in exports every .01 simulated time units, attaches,
reads two full live snapshots/static identities, pauses/resumes, and reads the
growing history while paused. It stops only its own processes. Select a new output
directory each time. The generated trajectory, worker log and `checks.json` are
external development evidence and must not be committed.

Focused regressions in `tests/test_companion.py` transfer the real particle count,
verify unchanged statics and acknowledgement pacing, recover from a nonfinite
capture without reattachment, and check budget negotiation/rejection/recovery
using small allocations. `tests/companion.test.ts` checks the connection messages.

## Verification

On 2026-10-18, the standalone reproduction passed with 765,418 particles:
first/subsequent live snapshots, pause/resume, and recorded history growing from
1 to 5 frames. A separate in-app browser check rendered the live frame, computed
kinetic/thermal/total energy and momentum, showed the paused state, and logged no
browser errors. The first state includes about 8.8 MiB of static arrays plus
23.4 MiB of dynamic arrays; subsequent captures reuse that static revision.

`npm test`: 103 passed. `npm run build -- --configLoader runner`: passed.
`PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 python -m pytest tests -q`: 75 passed.
The tested solver interpreter was the local `warp` environment (Python 3.13.14).
Generated logs, screenshot, checks and the standalone run are stored outside Git
under `warpSPHDevelopment/remote/large-live-20261018/`.

## Limits and next work

The default byte budget is a configurable memory guard, not a fundamental HTTP
or GPU limit. Raising it requires an explicit daemon restart, for example:

```bash
warpsph-companion --max-snapshot-mib 512 --python /path/to/warp/bin/python
```

Producer, daemon and browser still buffer whole packets with transient copies.
Higher resolutions reduce capture frequency via acknowledgement pacing, but GPU
readback/encoding still costs simulation time at a safe boundary. Large packets
may encounter memory, device-buffer or transport-time limits. Chunked acquisition
and selected-field transfers should reduce those costs in a later iteration.
The current envelope uses 32-bit part lengths; budgets remain below 4 GiB.

Already running publishers retain their imported code. Updating the checkout
alone cannot fix a publisher already inside a simulation; start a new run with
the updated adapter. Restart the daemon to replace its old packet validator or
change the byte budget. Exported history from the old run is retained on disk.
