# Local simulation companion

The static viewer remains usable without Python or warpSPH. The optional Linux
companion adds discovery, preset process management and one attached live viewer.
It is not a simulation editor, cloud scheduler or remote execution service.

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

The command prints `http://127.0.0.1:8766` and a fresh random pairing token.
In the hosted viewer choose **Local simulations**, enter the address/token and
Connect. A custom `--port`, private `--runtime` directory and additional exact
`--origin https://your-viewer.example` can be supplied on the CLI. The default
origin allowlist contains `https://fluids.dev` and Vite localhost ports 5173/5174.
An already-running singleton prints its existing address/token instead of
starting a second server. Tokens last for the daemon process lifetime; restarting
it rotates them. A completed simulation does not stop the resident daemon.

The browser and companion must be on the same machine, or use an explicit SSH
loopback forwarding arrangement. `localhost` means the browser's device. The
hosted site's JavaScript initiates the connection; GitHub Pages never receives
simulation data or pairing headers. Browsers may require local-network access
permission and have different HTTPS-to-loopback policies. The client supplies
`targetAddressSpace: 'loopback'` where supported and handles CORS preflight;
unsupported/denied browsers receive a connection error, not a security bypass.
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
that fragment from history immediately and keeps the token only in tab memory;
it is not saved in localStorage/IndexedDB or shared view links. Avoid sharing a
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
non-modal notice offers the simulation list without replacing the current
recording. Attach is deliberate.

`examples/live_simulation.py --case gresho --nx 128 --duration 3` demonstrates the
wrapper. For custom loops, use `SimulationPublisher` and call `post_step` at safe
completed-step boundaries, or `update(...)` plus `snapshot(...)` when
`wants_snapshot` is true. Close the publisher in `finally`; handle
`SimulationStopped` as a cooperative stop. Connectivity failures during a run
are recorded in `publisher.last_error` and do not stop simulation steps. Initial
registration failure is explicit. A crashed daemon is not automatically
re-registered mid-run in this version.

## Snapshot ownership and backpressure

- A file lock makes daemon startup singleton per user/runtime directory, including
  concurrent simulation-triggered starts. The daemon binds **only 127.0.0.1**.
  Incidental launches cannot enable external listening and do not print a token
  into incidental logs. An explicit CLI invocation can retrieve the token.
- A random browser bearer token controls manager/viewer endpoints. A separate
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
- The producer has at most one pending capture. HTTP transfers run on its thread;
  CPU copies and validation occur at the requested safe simulation boundary.
  This still has a measurable synchronization/copy cost while visualized. It is
  independent of rendering, not a zero-cost/zero-copy solver integration.

Live captures support up to 600,000 particles and a 128 MiB packet limit. An
unsupported optional capture reports a status message instead of stopping the
solver.

Live mode shares particle rendering, wrapping, GPU reconstruction/derivatives,
instantaneous streamlines, LIC, picked values and quantity analysis with recordings.
Energy/momentum diagnostics and pressure probes retain at most **600 displayed
snapshot samples** in browser memory. These are irregular samples: skipped solver
steps are not implicitly reconstructed or integrated. No full trajectory is
retained; time scrubbing, temporal particle/material traces and FTLE require a
recording and are disabled in live mode. Detach leaves the last displayed snapshot
available for inspection. Reloading the page requires pairing again.

## Preset execution

`python/warpsph_remote/presets.json` is the server's allowlist. It contains Gresho
(standard/smoothed cusp), RT, WC/incompressible TGV, KHH, periodic decaying random
flow and sloshing. Each has explicit solver choices and predefined variants.
The picker images are labelled schematic SVG illustrations, not solver captures.

Launch requests accept only registered preset/solver/variant, integer nx 8–512 (RT capped at 256 and sloshing at 384),
finite positive end time <=10000, and an optional bounded step limit. The browser
cannot set executable paths, import modules, arbitrary parameters or shell text.
Only one daemon-owned worker runs at once; separately started registered
simulations can coexist. Stop terminates a managed process group; external runs
stop cooperatively at their next publisher callback. Worker stdout/stderr and the
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

Remote listening remains deliberately unimplemented. The browser address field
can represent a future companion endpoint, but the daemon exposes no `--host`
flag, rejects non-loopback Host headers and cannot be made externally reachable
by a simulation or website request. A future explicit remote mode must add TLS,
CLI-only opt-in, separately scoped/revocable pairing, origin configuration and
appropriate process exposure policy. A token alone does not encrypt traffic.
Windows/macOS daemon installers, automatic reconnect across daemon restarts,
recording/retained live particle history, arbitrary case editing and launching
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
