# Local simulation companion

The static viewer remains usable without Python or warpSPH. The optional Linux
companion adds discovery, preset process management and one attached live viewer.
It provides managed case setup and execution, not arbitrary simulation code or a
cloud scheduler. Use localhost/SSH forwarding for normal operation. Direct HTTPS
is implemented as an explicit opt-in but further networking work is parked;
see the [consolidated status and priorities](ROADMAP.md).

## Install and start

In a Python environment with NumPy/h5py and an installed working warpSPH setup:

```bash
python -m pip install -e /path/to/warpSPHRemote
warpsph-companion --python /path/to/warp/environment/bin/python
```

`--python` selects the **trusted local** executable used to launch cases. Omit it
when the current environment already runs warpSPH. The companion itself imports
neither Torch nor Warp; the dedicated child worker bootstraps the simulator. Its fixed local entry script
loads only the companion package when using a different interpreter, without
adding another environment’s site-packages to the simulator’s import path.
Source installations must retain their usual warpSPH/Core/Boundaries import
paths and build environment. CPU can be selected with `WARPSPH_REMOTE_DEVICE=cpu`;
the default worker device is CUDA.

The command prints `http://127.0.0.1:8766` and the persistent local pairing token.
In the hosted viewer choose **Connect daemon**, enter the address/token and
Connect. A custom `--port`, private `--runtime` directory and additional exact
`--origin https://your-viewer.example` can be supplied on the CLI. The default
origin allowlist contains `https://fluids.dev` and Vite localhost ports 5173/5174.
An already-running singleton prints its existing address/token instead of
starting a second server. Pairing tokens persist per OS user and system across restarts, reboots,
Python environments and custom runtime directories. Producer credentials remain
random per daemon process. A completed simulation does not stop the resident daemon.

Retrieve the token at any time, including after an implicit launch, without
starting another daemon:

```bash
warpsph-companion --show-token
```

This prints the active daemon token if running, or the stored token if stopped.
The first use against an older running daemon preserves its existing token for
the upgrade when no persistent token has been created yet. The normal explicit
`warpsph-companion` invocation against an already-running daemon also performs
that migration. After this first upgrade, browser-saved pairing survives restarts.

To deliberately invalidate saved pairing, stop the daemon first, then run:

```bash
warpsph-companion --rotate-token
warpsph-companion --python /path/to/warp/bin/python
```

Rotation prints the new token and does not start a server. It refuses while the
selected runtime's daemon is running. All daemons for this OS user/system share
the persistent token; other custom-runtime daemons must also restart to adopt a
rotation. `--runtime /path/to/private/runtime` selects which active daemon is
queried or checked before rotation.

The credential lives in `$XDG_STATE_HOME/warpsph-remote/<system-scope>/pairing-token`
(default `~/.local/state/...`), with private directories and a mode-0600 file.
The scope hashes `/etc/machine-id`, falling back to the hostname, so shared home
directories do not automatically share pairing between systems. File locking and
atomic writes serialize first creation and rotation. Unsafe permissions,
symlinks, hard links, malformed credentials and oversized token files are rejected.
Runtime descriptor cleanup and reboot do not delete the persistent credential.
Incidental launches never print it to simulation logs. The default daemon remains
bound to localhost; persistence does not enable the explicit remote TLS listener.

For default loopback mode, the browser and companion must be on the same
machine or use explicit SSH forwarding. Direct remote HTTPS is described in
[Remote connections](REMOTE_CONNECTIONS.md). `localhost` means the browser's device. The
hosted site's JavaScript initiates the connection; GitHub Pages never receives
simulation data or pairing headers. Browsers may require local-network access
permission and have different HTTPS-to-loopback policies. The client supplies
`targetAddressSpace: 'loopback'` where supported and handles CORS preflight;
unsupported/denied browsers receive a connection error, not a security bypass.
Initial pairing waits up to 60 seconds to leave time for a permission decision;
the panel shows a waiting message and a **Cancel connection** button. Subsequent
API requests retain their 10-second deadline. Closing the panel cancels pending
pairing, and cancelled attempts cannot replace a later successful connection.
A local `npm run dev` viewer is also supported. For a separate simulation machine,
`ssh -L 8766:127.0.0.1:8766 simulation-host` forwards the protected endpoint to
the browser device without adding an external daemon listener. Pair using the
token printed on the simulation host.

References: [MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access),
[Chrome local network access](https://developer.chrome.com/blog/local-network-access).

## Desktop launcher

Install once from the Python environment that has the companion package:

```bash
warpsph-remote-open --install-xdg
```

This writes `warpsph-remote.desktop` under the user's XDG applications directory
and registers only the `warpsph://connect` handler. The viewer's **Open through
the desktop launcher → Start local companion** link invokes that handler. The
handler starts/reuses the loopback daemon and opens a new paired viewer tab.
Browsers may require confirmation to open the desktop application. No automatic
installation or browser permission changes are made by visiting the page.
The interpreter path is fixed when the handler is installed; reinstall it after
moving/deleting that environment.

The handoff token is in a URL fragment, never a query string. The viewer removes
that fragment from history immediately. After successful pairing, the viewer
remembers the endpoint/token in this browser's localStorage by default, as
requested for reconnecting between sessions. Uncheck **Remember pairing on this
browser** to keep it in memory only. **Disconnect** retains remembered pairing;
**Forget pairing** clears it and disconnects. Credentials are never added to
shared view links. Browser storage is scoped to the viewer origin and stores
the bearer token as readable JSON; it is not an OS credential vault. Changing
the address clears the prefilled saved token so it cannot follow a new server.
Restarting an updated companion preserves the token; explicit rotation changes
it. A rejected saved token is removed
and must be replaced from the terminal. Avoid sharing a
handoff URL. `warpsph-remote-open --print-url` is available for an explicit manual
handoff; treat its output as a credential.

## Existing simulation integration

No simulator source edits are necessary. After the normal warpSPH bootstrap:

```python
from warpsph_remote.publisher import run_live

# case is an existing warpSPH Case; keep the run's other required options.
result = run_live(case, nx=128, tLimit=3, plot=False, store=False,
                  show=False, holdPlot=False, progress=False)
```

`run_live` preserves the case's `postStep` hook and adds a completed-step publisher.
It auto-starts/reuses the daemon, registers a run and sends status about twice a
second from a background thread while idle. An attached producer polls small
capture commands more frequently (20 ms); the browser requests at most about
10 snapshots/s and waits for renderer acceptance before allowing another capture.
An unattached run sends start time, PID, particle
count, step, physical time, dt and solver name; it does not copy particle arrays
to the CPU or transmit states. A new run appears in the resident manager and a
non-modal notice offers the simulation list by default. Launching a preset from
this viewer automatically attaches it and closes the picker. Optional monitor
mode also follows newly discovered external launches; see below.

`examples/live_simulation.py --case gresho --nx 128 --duration 3` demonstrates the
wrapper. For custom loops, use `SimulationPublisher` and call `post_step` at safe
completed-step boundaries, or `update(...)` plus `snapshot(...)` when
`wants_snapshot` is true. Close the publisher in `finally`; handle
`SimulationStopped` as a cooperative stop. Connectivity failures during a run
are recorded in `publisher.last_error` and do not stop simulation steps. Initial
registration failure is explicit. A crashed daemon is not automatically
re-registered mid-run in this version.

## Automatic attachment and monitor mode

Launching a preset from the viewer closes the simulation picker and queues its
live connection immediately. The viewer waits for producer registration and
then the first captured frame; startup/compilation does not cause an early
"still starting" attachment error. A small **Connecting to …** notice remains
visible during startup, with **Cancel connection**. Cancelling viewing does not
stop the simulation. Startup failures return a message in the manager.

Under **Local simulations**, enable **Automatically watch new simulations** to
use this page as a monitor. It is off by default and remembers its setting in
this browser. On connection/enabling, it follows the newest active run; while
connected it switches to newly discovered launches, including simulations
registered through `run_live` outside the viewer. Discovery uses the existing
one-second status poll. Only the newest active launch is shown if several arrive
at once, matching the single-viewer design. Other simulations keep running.

With monitor mode off, externally launched runs produce a notification and keep
the current recording/live view in place. Viewer-launched presets still attach
automatically. Turning monitor mode off does not detach the current live view.
Manual detach/cancellation is respected for that run; only a later launch causes
a new automatic switch. Disconnecting or changing daemon invalidates pending
attachments. An existing viewer lease is never stolen; conflicts appear in the
manager. These controls do not enable trajectory recording.

## Pause and exported history

Restart the companion after updating its editable install; a running daemon
keeps its loaded code. The viewer discovers optional features from the session
response, so older companions retain their existing launch/live behavior.

In **Local simulations**, **Pause** requests a hold at the next completed-step
publisher callback. The row shows `paused` only after the simulation acknowledges
it. **Resume** continues the integrator. The main plot's play/pause button and
Space shortcut control the simulation in live mode; recorded trajectories retain
their normal playback controls. The live transport shows Pausing/Paused/Resuming
status and disables recording-only speed/loop/seek controls. Pausing during initial compilation takes effect at the first callback.
The publisher keeps heartbeats, live capture, history requests and cooperative
stop active while paused.

Preset launches leave **Record trajectory (uses disk space)** unchecked. Enable
it deliberately and choose an export interval in simulation-time units. Managed
exports are written under `<runtime>/runs/<id>/exports/`; they are not duplicated
into a second remote recording and are not deleted automatically. No particle
history is recorded for an ordinary unchecked launch.

Existing code can expose its normal exports:

```python
result = run_live(case, nx=128, tLimit=3, plot=False, store=True,
                  storeMode='trajectory', exportInterval=0.05,
                  exportRoot='/path/to/my/exports')
```

For a run with export enabled, **View history** opens the available recorded
frames as a regular trajectory: seek/playback, diagnostics, probes, traces and
analysis use the recording source. Its frame index refreshes every two seconds
while that source remains selected. **Watch live** switches to current snapshots.
Switching views neither resumes a paused solver nor enables recording. History
is still available in **Show finished simulations** after a clean stop/completion,
as long as the daemon session and export files remain available. After a page
refresh, remembered pairing can reconnect on demand; select the run's history
again. Finished run metadata does not survive daemon restart even when its files
remain on disk; surviving active producers re-register separately.

The existing HDF5 trajectory layout is not SWMR. For an active producer, the
daemon forwards one bounded history request to the simulation adapter; it reads
existing numeric datasets between output writes on the simulation thread. The
network transfer is handled by the publisher thread. The daemon reads directly
only after the writer has closed. No file-lock checks are disabled, no pickle or
checkpoint callables are evaluated, and browser requests cannot choose local
filesystem paths. A long timestep can cause a retryable history timeout.
Metadata refresh reads the recorded index; frames are fetched lazily. The browser
keeps at most eight cached frame/field responses, bounded by 64 MiB. History reads
add disk/CPU work at a step boundary, so intensive analysis may slow the solver.

Both trajectory exports and completed per-state HDF5 exports are supported;
per-state history contains the initial state and `state_*` exports. The existing
viewer supports 2D/3D numerical arrays; a 1D recording still requires a viewer
adaptation. Only fields actually exported are available for recorded analysis.
Numerical packets have no fixed particle-count cap. The live snapshot budget
(default 128 MiB, configurable below) also bounds active history uploads. Abrupt process kills may leave an incomplete
HDF5 file; graceful stop/normal completion is the supported history handoff.

## Snapshot ownership and backpressure

- A file lock makes daemon startup singleton per user/runtime directory, including
  concurrent simulation-triggered starts. Its default/local listener binds **only 127.0.0.1**.
  An explicit CLI-only TLS viewer listener is available; see [remote setup](REMOTE_CONNECTIONS.md).
  Incidental launches cannot enable external listening and do not print a token
  into incidental logs. An explicit CLI invocation can retrieve the token.
- A persistent random browser bearer token controls manager/viewer endpoints. A separate
  random producer credential is held in a private descriptor (directory 0700,
  file 0600); it is never sent to the webpage. Host and exact Origin checks defend
  the loopback endpoint against unrelated websites and DNS rebinding.
- One viewer lease may own one run at a time. Lease renewal is metadata only.
  Closing/crashing a tab expires the lease after 20 seconds and frees state buffers;
  explicit detach releases immediately. Another viewer receives a conflict.
- On attachment the producer is asked for the next safe completed state. It copies
  only that state. A WPR1 packet holds dynamic arrays; a separately hashed revision
  holds UIDs, kinds and masses. Unchanged static arrays are reused. Changed counts,
  ordering, IDs, kinds or masses send a fresh static revision. Int64 UIDs remain
  exact; coordinates remain unwrapped. No quantization is introduced.
- The daemon retains one immutable snapshot, with no accumulating frame queue.
  The browser pulls it and reconstructs/renders through the existing source
  contract. Only after successful renderer submission does it acknowledge that
  sequence. The daemon then asks for a new state. Capture generations reject
  stale uploads after detach/reconnect; stale/double acknowledgements are rejected.
- At a frozen safe boundary, the publisher holds the next capture request after
  successfully publishing that step/time/static revision. It does not repeatedly
  copy and send identical paused states. A new lease clears static data and still
  receives the paused state. Resuming produces a new state normally. The browser
  also ignores duplicate safe-boundary captures from older publishers, so they
  cannot trigger repeated grid reconstruction. Local quantity/settings changes
  still recompute once on the held frame.
- The producer has at most one pending capture. HTTP transfers run on its thread;
  CPU copies and validation occur at the requested safe simulation boundary.
  This still has a measurable synchronization/copy cost while visualized. It is
  independent of rendering, not a zero-cost/zero-copy solver integration.

There is no fixed live particle-count cap. The daemon defaults to a **128 MiB
budget per snapshot envelope**, including any static revision accompanying it.
This is an allocation/transfer guard for whole buffered packets, not a WebGPU,
HTTP or particle-count limit. Explicitly starting the daemon with, for example,
`warpsph-companion --max-snapshot-mib 512 --python /path/to/warp/bin/python`
raises the budget; restart the daemon to change it. The descriptor and producer
status response advertise the selected byte budget, so the adapter checks the
same limit before encoding. Active history uploads use that budget too. The
current WPR1 envelope uses 32-bit part lengths; CLI budgets are 1–4095 MiB.

Larger frames naturally reduce capture frequency through the same acknowledgement
handshake. They still require GPU-to-CPU synchronization, encoding and multiple
resident copies across producer, daemon and browser; 128 MiB on the wire does
not mean 128 MiB total process memory. Browser/GPU resources and transfer time
remain practical constraints. Chunked numerical transfers and field selection
are future memory/latency improvements, not prerequisites for nx=256 triplePoint.

A rejected optional capture reports its reason in the live connection notice and
run row without stopping the solver or disabling controls. It does not consume
the outstanding request: capture retries at most twice a second at safe boundaries,
including while paused, and clears its capture message on successful preparation.
See [large live-frame reproduction](LARGE_LIVE_FRAMES.md).

Live mode shares particle rendering, wrapping, GPU reconstruction/derivatives,
instantaneous streamlines, LIC, picked values and quantity analysis with recordings.
Energy/momentum diagnostics and pressure probes retain at most **600 displayed
snapshot samples** in browser memory. These are irregular samples: skipped solver
steps are not implicitly reconstructed or integrated. No full trajectory is
retained; time scrubbing, temporal particle/material traces and FTLE require a
recording and are disabled in live mode. Detach leaves the last displayed snapshot
available for inspection. After reloading, remembered pairing prefills the
connection form; choose Connect and Watch live again. Reload/close sends a
best-effort authenticated lease release so reattachment can happen immediately.
If the browser cannot deliver that request, the usual 20-second expiry applies.

## Preset execution

`python/warpsph_remote/presets.json` is the server's allowlist. It contains Gresho
(standard/smoothed cusp), RT, WC/incompressible TGV, KHH, periodic decaying random
flow and sloshing. Each has explicit solver choices and predefined variants.
The picker images are labelled schematic SVG illustrations, not solver captures.

Launch requests accept only registered preset/solver/variant, integer nx 8–512 (RT capped at 256 and sloshing at 384),
finite positive end time <=10000, an optional bounded step limit, an opt-in
`record` flag and a finite export interval (1e-6–10000 simulation-time units). The browser
cannot set executable paths, import modules, arbitrary parameters or shell text.
Only one daemon-owned worker runs at once; separately started registered
simulations can coexist. Pause/resume and stop are cooperative at the next
publisher step boundary. Managed workers get ten seconds to stop and close their
recording before a process-group SIGTERM fallback; unregistered workers can be
terminated immediately. External processes are never signalled by the daemon. Worker stdout/stderr and the
normalized launch specification remain in `<runtime>/runs/<id>/`. They may contain
useful local failure diagnostics; the webpage sees only bounded status messages.
The manager retains at most 128 run summaries per daemon session.

## Validation and regeneration

```bash
python -m pip install -e '.[dev]'
pytest -q
npm test
npm run build
```

Tests cover token/role/origin/Host checks, CORS, singleton concurrent startup,
private descriptor permissions, bounded launch specs, metadata-only registration,
single-viewer leases, expiry, static reuse, exact int64 UIDs, backpressure,
malformed packets and stale captures/acks. Browser tests cover secret-fragment
consumption, endpoint validation, static packet merging and renderer-gated ACKs.

The development smoke run on 2026-10-17 executed all seven default case families
at nx=16 with a two-step limit/end time .001, through the authenticated manager.
A longer nx=128 CRKSPH Gresho run exercises browser launch/attach and grid viewing.
These smoke checks verify integration; they do not validate every advertised
solver/variant physically. Existing warpSPH case-specific constraints still apply.
Generated logs/captures are under the sibling development evidence tree, never in
this source checkout. See the final evidence record for measured checks.

## Deferred extension

Direct authenticated HTTPS remote listening is now implemented as an explicit
CLI option, with a separate remote token and loopback-only producer access. See
[Remote connections](REMOTE_CONNECTIONS.md) for IP/DNS certificate setup,
VPN/firewall requirements, SSH fallback and verification limits.
Windows/macOS daemon installers,
automatic recording of live snapshots, arbitrary case editing and launching
multiple managed GPU workers are outside this pass.

Regenerate the seven default-family smoke checks after starting a companion in
an installed warpSPH environment (uses only small nx=16 runs):

```bash
python examples/check_companion_presets.py --runtime /path/to/private/runtime \
  --output /path/to/warpSPHDevelopment/remote/new-companion-smoke
```

2026-10-17 verification: 40 Python tests and 85 TypeScript tests passed; the
production build passed. Browser checks covered pairing/fragment removal, preset
launch, 16,384-particle CRKSPH Gresho through t≈3, live scalar-grid reconstruction,
pressure-history growth, explicit detach, reconnect with the chosen grid retained,
and a 4,096-particle follow-up run. No browser console errors were observed during
these checks. Evidence is retained in
`../warpSPHDevelopment/remote/local-companion-20261017/`.

The deployed HTTPS page's manager UI was verified, but its loopback pairing
request timed out in the current in-app browser. The localhost-hosted viewer
completed live launch/attach/grid/probe/reconnect checks. The user subsequently
confirmed hosted-page pairing works in Chrome on Windows. Firefox 154.0.1 under
WSL with X forwarding showed a native permission popup that ignored both Allow
and Block; an unauthenticated curl from the same WSL environment returned the
expected HTTP 401. That proves direct daemon reachability, but does not establish
the browser request's behavior. Investigation of that WSL-specific popup was
stopped at the user's request. No browser security settings were changed.

Pairing UI follow-up: 87 TypeScript tests and the production build passed. An
isolated companion fixture delayed the initial session response by 30 seconds;
pairing still completed. A separate browser check paused only that fixture,
cancelled the pending connection, then resumed it and successfully retried. Token
rejection, request timeout and opaque browser network failures have distinct
messages. Evidence is in
`../warpSPHDevelopment/remote/pairing-permission-20261017/`. These changes improve
connection feedback; they do not repair an unresponsive native permission popup.

A separate-interpreter smoke check passed: the companion ran in its NumPy/Python
environment and launched Gresho in the Warp environment without the companion
package on the child PYTHONPATH. The isolated-script test also checks package
bootstrap without inheriting another environment's site-packages.

## Pause/history validation (2026-10-18)

44 Python tests and 89 TypeScript tests passed, along with the production build.
The real CUDA integration check held TGV at step 0, resumed it, read 156 exported
frames while paused, resumed and read 214 frames, captured a live snapshot while
paused, then stopped and read all 214 frames after writer closure. A second
managed run with default options generated no HDF5 trajectory. The core runner
also tests writer closure when a control hook interrupts a recorded run.

Reproduce against a working warpSPH interpreter, choosing a fresh output path:

```bash
python examples/check_live_history.py --python /path/to/warp/bin/python \
  --output ../warpSPHDevelopment/remote/new-pause-history-check
```

Evidence is stored outside source under
`../warpSPHDevelopment/remote/pause-history-20261018/`.

The local browser preview also verified recorded-history seeking, switching to
live grid viewing while paused, stopping through the manager and an unchecked
recording option by default. No browser console errors were observed.

## Live transport and remembered pairing follow-up (2026-10-18)

The disabled button reported in the live plot was still wired to recorded-file
playback (`frames < 2`). It now shares the manager's simulation pause/resume
commands, independent of renderer errors and the one-frame live source. Command
errors are shown in the manager; stopped/detached runs and older daemon versions
cannot issue controls. Pairing storage saves only successfully validated
credentials, supports explicit forgetting and handles blocked browser storage.

93 TypeScript tests and the production build passed. Browser verification with
an isolated 256-particle producer exercised the main transport's enabled Pause
and Resume controls, a stable acknowledged paused step, remembered address/token
after reload, reconnect without re-entry, immediate live reattachment after
pagehide lease release and explicit forgetting. This is an acquisition/UI
regression check; no numerical solver changes were made. Evidence lives under
`../warpSPHDevelopment/remote/live-controls-pairing-20261018/`.

To reproduce the browser check without a solver:

```bash
python examples/live_controls_fixture.py \
  --output ../warpSPHDevelopment/remote/new-controls-fixture
```

The fixture uses localhost port 18767 and the synthetic token printed in its
terminal. Connect from the viewer, Watch live, pause/resume from the plot, reload
and reconnect without entering credentials, then Forget pairing and reload.
Its fixed token protects synthetic test data only; it is not a production daemon.

## Auto-attach/monitor verification (2026-10-18)

97 TypeScript tests and the production build passed. Browser checks launched a
real nx=64 CRKSPH Gresho case through the preset picker: the picker closed,
startup status appeared and the 4,096-particle run attached without Watch live.
The isolated run was paused at step 1742, t≈2.4867, and stopped after testing.
Monitor mode followed two external synthetic producers in sequence, kept the
current view for a third while disabled, survived reload/reconnect, respected
manual detach and honoured cancellation before delayed producer registration.
No browser console errors were observed in the final checks.

Reproduce using an installed working warpSPH interpreter and a fresh output path:

```bash
python examples/auto_monitor_fixture.py --python /path/to/warp/bin/python \
  --output ../warpSPHDevelopment/remote/new-auto-monitor-fixture
```

The fixture prints its isolated localhost endpoint and test token. Launch a small
preset from the browser, then enable monitor mode. Creating `external-one.start`
and `external-two.start` in that output directory registers synthetic producers.
For cancellation, create `external-delayed.start`; cancel its startup notice,
then create `register-delayed` to allow registration. The current view should
remain unchanged. Ctrl+C stops fixture-owned runs. This is a UI/acquisition
check; it does not validate new numerical methods. Evidence is under
`../warpSPHDevelopment/remote/auto-monitor-20261018/`.

### Persistent pairing verification

Run `PYTHONPATH=python python -m pytest tests/test_persistent_pairing.py -q` to
exercise concurrent creation, system scoping, private file/directory checks,
symlink and hard-link rejection, relative-path rejection, explicit rotation and
legacy-token migration. The integration check starts and stops actual incidental
loopback daemons, deletes the temporary runtime directory between starts, and
checks stable viewer credentials with fresh producer credentials. It also checks
CLI retrieval while stopped, refusal to rotate while active, and adoption of the
rotated token by a later start. Test credentials are isolated under pytest's
temporary XDG state directories; the tests never retain real user pairing state.


## Viewer takeover and daemon restart recovery

If a refreshed or second tab encounters an active viewer lease, its error panel
offers **Take over connection**. This is an explicit authenticated attachment,
not a forced heartbeat. The old viewer retains its last frame, stops renewing
the lease and can reconnect deliberately. Simulation execution and pause state
are unchanged. An old tab's delayed detach, acknowledgement or capture cannot
displace the new owner. A takeover also works between two runs on the daemon's
single live connection and for an acknowledged paused boundary.

An unreachable daemon now appears as **Daemon unavailable**, with **Reconnect
now** and **Connection settings**. The browser retains pairing and its last
frame, disables unavailable run actions and retries at three-second intervals.
Recovery refreshes the daemon's case catalogue and capabilities; monitor mode
can reattach recovered runs. Authentication failures offer settings for pairing
again rather than silently forgetting credentials. Initial pairing retains its
existing sixty-second permission deadline; recovery requests use ten seconds.

The producer thread reloads its private runtime descriptor after a daemon change
and re-registers the same run ID, PID and original start time with the replacement
producer credential. A paused integrator stays paused during the outage and is
registered as paused before commands are accepted. The new daemon can then
resume or stop it normally. Pending capture/history transport work is discarded
and a fresh snapshot is requested after attachment. An existing recording is
re-advertised through ordinary producer status, without enabling export.

Stopping the daemon service itself now preserves its simulations; **Stop** on a
run is the explicit operation for stopping a simulation. The daemon does not
respawn automatically after being deliberately stopped. Producers wait for a
replacement at the same runtime directory; its endpoint may change, while the
browser must still be pointed at the corresponding address. Recovered workers
are controlled cooperatively through the adapter, without claiming a new OS
parent/child process handle or sending arbitrary signals.

**Upgrade boundary:** restart the daemon and start simulations with the updated
adapter once to enable this behavior. Python code already loaded in an older
process does not acquire recovery retroactively; an already orphaned old adapter
cannot be repaired by refreshing the website. Older daemons lack the takeover
capability, and the viewer explains that a companion update/restart is needed.

See [reconnection verification](RECONNECTION.md) for reproduction commands.

Buffered CPU snapshots, independent update pause, synchronized live/trajectory
video export and read-only running configuration inspection are described in
[Buffered capture and video](BUFFERED_CAPTURE_AND_VIDEO.md). Restart the daemon
and start new simulations after updating to negotiate these adapter capabilities;
existing Python processes retain their already-imported implementation.
