# Profiles and simulation workflows

## Generic profiles (phase one)

Open **Quantity analysis → Profile / scatter plots**. Add up to twelve independent
plots; choose a recorded field, Cartesian coordinate/radius/xy angle, scalar or
vector component, magnitude, radial projection, or signed xy tangential
projection. Radius and radial velocity use every spatial dimension. A singular
projection at the origin is omitted rather than assigned a fictitious direction.

Scatter collapses coordinates without averaging. Its display is deterministically
sampled to at most 30,000 particles; CSV exports those plotted points, preserving
exact UIDs as strings. Clicking a point selects that UID in the main view (visible
when the dialog is closed), including material retracking when enabled. UIDs and kinds are excluded from the quantity picker; UID
identity is never converted to floating point.

Binned profiles use all accepted particles, with count, mass or volume (m/rho)
weighting. Error bars are weighted population standard deviation, not standard
error. Log-x bins are uniform in log coordinates. The filters support fluid,
particle kind, a recorded material field, Cartesian slices, and xy angular sectors
(including sectors crossing the -pi/pi seam). Nonfinite values, invalid weights,
and nonpositive log samples are omitted and counted.

Coordinates can use recorded unwrapped positions or domain-wrapped positions;
radial displacement from the chosen centre is ordinary Euclidean displacement,
not a minimum-image radial distance. Each card reports its computed snapshot time.

Computation runs in a dedicated browser worker per open card. Work is serialized
per card and pending live updates collapse to the latest displayed frame, so a
slower analysis can finish without blocking simulation snapshot acknowledgement.
Paused duplicate snapshots at the same time do not recompute profiles. No new
simulator dependency is needed for recorded trajectories. Plot definitions persist
in browser local storage per trajectory name. Case defaults, reference overlays,
and portable analysis-result attachments belong to subsequent phases.

## Separate simulation tasks

The main header now exposes **Running simulations**, **Run history**, **Run
simulation**, and **Connect daemon / Daemon connected**. A task requiring a
connection first shows pairing, then continues to the requested task. Remembered
pairing reconnects on demand. The connection menu owns disconnect, forget, and
**Refresh available cases**. Monitor mode remains in Running simulations; closing
any manager dialog preserves the connection and live lease.

Run history is metadata for the current daemon session, including ongoing runs.
Only runs with opt-in trajectory recording offer history replay. Neither launching
nor browsing enables recording implicitly. Completed metadata is not persisted
across daemon restarts in this phase.

The launch wizard has four steps: family, case, case parameters, solver/run
settings. Back navigation retains the selected configuration. Choosing a different
case resets overrides; changing solvers resets numerical solver overrides. A
successful launch still closes the picker and attaches automatically.

## Daemon-owned catalogue and configuration bridge

`GET /v1/session` discovers cases in the daemon's configured simulation Python.
The original presets are convenience aliases with curated resolution bounds and
schematics; they do not restrict discovery. Additional registered installed cases
appear without a viewer rebuild. Case family, variants, supported solvers,
availability/reason, and configuration capability are advertised by the daemon.
Cases whose advertised setup defaults to 1D remain unavailable to the current
2D/3D viewer; the launcher does not infer extra dimensional support from generic
configuration controls. Legacy
registered cases can launch with preset settings; fully migrated cases expose
schema-driven controls. A discovery failure disables launch entries while retaining
daemon pairing and simulation monitoring. Refresh repeats discovery and clears
cached schemas. Newly installed cases must be registered by the installed solver's
case catalogue to be discoverable.

`GET /v1/configuration?preset=…&scheme=…` returns the installed solver's versioned
configuration schema. The UI groups controls by descriptor metadata, handles
conditional applicability/read-only/derived fields, and submits only enabled
sparse overrides. Current structured object/array parameters use JSON input;
nested solver groups use ordinary controls. Inactive case overrides are omitted.

The managed launch endpoint accepts bounded preset/run controls and an optional
`configuration` containing `params`, `solver`, and curated `simulation` settings.
The installed `RunConfiguration` resolves and `prepareContext` validates them before
a process is launched, and the worker resolves them again before constructing the
system. The companion continues to own execution paths, output paths, device,
plotting, recording and process lifecycle. Browser input cannot select executables,
modules, Python source, shell commands or checkpoint/output paths. Configurable
forms require the solver's `RunConfiguration`/`configurationSchema` contract;
older solvers retain preset launching.

## Verification and regeneration

Run from the repository:

```bash
npm test
npm run build
PYTHONPATH=python python -m pytest tests -q
PYTHONPATH=python WARPSPH_COMPILE_WALLS=1 python examples/check_configuration_bridge.py \
  --python /path/to/warp/bin/python --output /tmp/configuration-bridge-new-run
```

Tests cover coordinate/vector projections, exact IDs, weighting/spread,
wrapping/log masks, slice/sector/material selection, sparse conditional overrides,
managed parameter restrictions, catalogue caching/refresh, and invalid
configuration rejection before process startup, alongside existing live transport
and history regressions.

Browser verification used an isolated companion and a real CRKSPH Sod 2D run at
nx=32 with `left_rho=1.5`: launch closed the wizard and attached; pause settled at
step 725, t≈5.8737, with 748 particles; scalar scatter and volume-weighted profiles
rendered; stop appeared in the separate history view with recording disabled.
Recorded KHH (65,536 particles) also exercised the profile worker and vector
projection. Generated evidence belongs outside source, under
`warpSPHDevelopment/remote` or a fresh disposable `/tmp` directory.
