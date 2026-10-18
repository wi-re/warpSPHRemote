# Live connection handoff and restart verification

These changes address refreshed tabs colliding with an old live-viewer lease,
raw `Failed to fetch` errors after daemon shutdown, and paused simulations losing
their controller when a daemon restarts. Protocol endpoints remain authenticated
and loopback-only. The single-viewer limit is retained, with an explicit handoff.

## Checks

```sh
npm test
npm run build
PYTHONPATH=python /path/to/warp/bin/python -m pytest tests -q
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/bin/python \
  examples/check_daemon_recovery.py --python /path/to/warp/bin/python \
  --output /tmp/FRESH-daemon-recovery
```

The real-solver check launches its own private daemon and an unrecorded TGV. It
pauses the solver, kills only that daemon, starts a replacement, confirms the same
PID/run/step is still paused, repeats with a graceful daemon restart, then resumes
and stops through the API. On 2026-10-18, TGV stayed paused at step 116 through both
restarts, resumed to step 173, and stopped normally. Pairing was unchanged.
No user daemon or simulation is contacted; generated output remains outside Git.

Python regression tests cover ordinary attach conflicts, explicit authenticated
takeover, rejection of stale heartbeats/ACK/detach/uploads, transfer of a pending
terminal snapshot, paused fresh captures, invalid-target atomicity and idempotent
producer recovery without overwriting resume/stop commands, and rejection of
frame encodes that straddle a transport recovery. A two-server test
changes endpoint and producer credential while preserving the integrator thread.

For browser verification:

```sh
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 /path/to/warp/bin/python \
  examples/reconnection_fixture.py --output /tmp/FRESH-browser-reconnection
npm run dev -- --port 5174 --strictPort
```

The fixture prints its synthetic-only pairing credential. Open two viewer tabs,
connect to the fixture, watch and pause in the first tab, then watch in the
second. The second offers **Take over connection**; after takeover it gets the
same paused step and the first becomes a detached snapshot. It must not
silently reclaim the connection via heartbeat.

Create `offline.request` under the fixture output to stop only its child daemon.
The synthetic producer stays alive. Reopen the simulation menu: the offline
banner must retain pairing, disable unavailable run actions and offer reconnect.
Create `online.request` to restart the daemon. The same paused run reappears;
monitor mode can attach it automatically. Resume and stop from the UI to verify
control after recovery. The fixture ends when its synthetic run is stopped, or
on Ctrl+C/timeout. Store screenshots and raw measurements outside source.

Browser tests use a CPU-only synthetic producer; the separate real TGV check
exercises the actual worker/bootstrap/adapter path. Current already-loaded old
adapters need a new simulation process to gain recovery support. See
[local companion](LOCAL_COMPANION.md#viewer-takeover-and-daemon-restart-recovery)
for service shutdown and upgrade semantics.

The final suite contains 110 browser/data tests and 94 Python tests. Browser
verification additionally confirmed that monitor mode reattached the same paused
256-particle run at step 6,875 after restart with a new snapshot sequence, and
that Resume advanced it and Stop ended the fixture without a forced process kill.
