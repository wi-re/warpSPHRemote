# Dimension, timestepper and repeat launches

## Usage

Update the companion checkout/environment and restart its daemon when convenient;
already-running daemons retain their imported bridge and cached catalogue. Refresh
the webpage and reconnect. No change to a running simulation is required.

In **Run simulation → choose a case → Case parameters**, use **Dimension** above
Solver and Variant. Sedov advertises 1D, 2D and 3D. Cases with a fixed sampler,
such as the 1D Sod case, show their fixed dimension. The daemon discovers dimensions
from the installed case configuration contract, including inherited descriptors;
the browser has no separate case allowlist. Resolution is **nx per axis**, with
actual counts depending on domain geometry and boundaries. Existing per-dimension
resolution limits are advertised and validated by the daemon. Switching dimension
clamps nx to that dimension's limit, visibly updating the resolution field.

In **Solver and run settings**, **Timestepper · integration method** is a visible
selector above resolution/end time. RK2 (midpoint), RK4, Euler methods, Heun, RK3,
SSP RK3, Leapfrog and Velocity Verlet are shown when present in the installed
enum. The case/variant default is explicit and does not serialize an override.
The timestepper is separate from Δt; dt, adaptiveDt, CFL factor and min/max dt
are adjacent override controls. Unchecked fields inherit the case/variant defaults.

This pass does not validate the whole warpSPHIntegrators registry. Known classic
mechanics methods lack the RK stage weights needed by CRKSPH/CompSPH's
`compatibleEnergy` update. Those mechanics methods are omitted for that solver, and the daemon
rejects an incompatible explicit request before creating a worker. Choose an RK
method or another solver such as Monaghan. The current solver contract does not
expose a compatibleEnergy toggle; no energy setting changes automatically. MFM/MFV's single-evaluation integrator restriction is reflected in
the advertised selector. Numerical suitability/stability remains case-dependent.

**Run history → Run again** (also in the run report) opens a reviewable launch
draft for completed/failed/stopped/interrupted managed runs. It retains the saved
case, variant, solver, dimension, integration method, case/numerical overrides,
resolution, end time or step limit, pause state, diagnostic settings, trajectory
cadence and video settings. Nothing launches until Run is pressed. This starts
from initial conditions, not a checkpoint. Run IDs, leases and output paths are
not copied. A missing case, incompatible capability, unavailable dimension or
changed parameter schema produces an explanation rather than silently dropping
saved settings. Externally registered runs without a saved launch request cannot
use this action. Defaults and installed case code can change between runs.

## Validation and regeneration

```bash
npm test
npm run build
PYTHONPATH=python /path/to/warp/python -m pytest -q
PYTHONPATH=python /path/to/warp/python examples/check_launch_parameters.py \
  --python /path/to/warp/python \
  --output /path/to/warpSPHDevelopment/remote/new-launch-check
```

The reproduction creates an isolated companion and checks initial 2D Sedov frames
and completion after two steps with CRKSPH/RK2, CRKSPH/RK4 and
Monaghan/Symplectic Euler. It does not use the user's daemon. Use
`--browser` to retain the fixture on port 18770 for a setup/re-run UI check; serve
the frontend on 127.0.0.1:5176. The fixture exits after 15 minutes or a
`stop.request` file in its output directory. All generated evidence belongs
outside this checkout.

Observed on 2026-10-18: all three 2D Sedov checks completed at step 2 (nx=16,
289 sampled particles including endpoints). The browser's Run again action
restored 2D/RK4, switched 3D resolution bounds and returned to 2D, then launched a
reviewed nx=24 CRKSPH/RK4 run. It showed a paused initial 625-particle frame and
completed after Resume. TypeScript tests: 127 passed; Python suite: 126 passed,
followed by 12 configuration tests after the classic compatibility guard was
added. Production build passed. Evidence lives in
`warpSPHDevelopment/remote/rerun-dimension-integrators-20261018-verified/`.
