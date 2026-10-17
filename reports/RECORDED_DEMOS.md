# Shipped solver recordings

The user explicitly requested these three trajectories in the repository to
share the viewer with colleagues without distributing data separately. This is
a narrow product-data exception to the development-evidence storage contract.
Only the three files named in `web/src/recorded-demos.json` are allowed by the
`.gitignore` exception. Full simulations, summaries, logs, intermediate exports
and screenshots remain outside Git.

| File in `web/public/demos/` | Particles | Frames | Simulated duration | Bytes |
|---|---:|---:|---:|---:|
| `random-wcsph-128.h5` | 16,384 fluid | 61 | 6 | 16,505,671 |
| `sloshing-200.h5` | 10,660 total / 4,200 fluid | 71 | 7.0001 | 7,899,034 |
| `khh-crksph-256.h5` | 65,536 fluid | 41 | 3.999181509 | 48,963,114 |

The compact files use gzip level 9, byte shuffle, one-frame chunks and exact
deduplication of arrays constant across every retained frame (supports). All
dynamic arrays remain float32 and identities remain exact; no quantization,
coordinate wrapping, interpolation or physical-unit conversion is applied.
Domain metadata drives display mapping. Timestamps are actual solver times,
sampled approximately every 0.1 simulated seconds, with first/last states kept.

## Random-flow run

warpSPH checkout `33d4d94ad4117ed9bc7608c10c62bc151130e6c3`, case
`warpSPH.cases.periodic.randomFlow.randomFlowCase`, deltaSPH (WCSPH), 128²
particles in the periodic [-1,1]² domain. Seed 20261017 initializes a tileable
Perlin potential with three octaves; its rotated SPH gradient gives the seeded
divergence-free velocity field, normalized to maximum speed one before stepping.
There are no walls, obstacles, gravity or external forcing. Kinematic viscosity
is 0.005 (`inviscid=False`), Wendland4 kernel, RK2 integration and fixed
dt=0.00025. The existing case's timestep setup selects sound speed 34.5424893.

24,000 steps completed in 167.21 wall seconds on the RTX PRO 6000 Blackwell, with
`diverged=False`, no stop reason and no velocity alarms. The recording starts
after the first complete step at t=0.00025, when solver pressure is available,
and finishes at t=6.000000000001587. The initial t=0 recording attempt was
discarded because pressure had not been populated; its failed run folder/log
is preserved separately. No solver changes were needed.

Recorded kinetic energy decays from 0.3041526589 to 0.02450818365 (about 91.9%).
Maximum speed decreases from 0.999679 to 0.228571. All recorded arrays are finite;
density stays between 0.9999245 and 1.0015726. Coordinates remain unwrapped
(overall extent approximately -2.20951 to 1.94014). This is weakly compressible
WCSPH with evolving density and EOS pressure, not an ideal-gas thermal-energy
solver: no internal or total thermal energy is invented. It is a visualization
example, not a convergence or turbulence validation benchmark.

## Sloshing run

Uses the previously completed nx=200 deltaSPH sloshing recording described in
[SOLVER_DEMOS.md](SOLVER_DEMOS.md). This copy retains 71 whole states from the
281-frame external recording, without rerunning or changing the simulation.
The original finer export remains available outside Git. The reduced cadence
is intended for UI feedback and can miss short pressure peaks; do quantitative
probe analysis on suitably sampled original recordings.

## Kelvin–Helmholtz run

The KHH example is a losslessly compressed, lower-cadence copy of
`browser-demos-20261017/khh-crksph-256-energy.h5`, from the completed 256² CRKSPH
run described in [SOLVER_DEMOS.md](SOLVER_DEMOS.md). It retains 41 whole states
through t=3.999181509, approximately every 0.1 simulated seconds. Initial time is
0.0003613133 (after the first solver step). Positions remain unwrapped and domain
metadata declares periodic [0,1]². All 65,536 particles, exact UIDs, velocities,
pressure, density, supports, masses, and global kinetic/internal/total energy
samples are retained at matching timestamps. No values are quantized or resampled.

The package is 48,963,114 bytes (46.7 MiB), down from about 186 MiB / 161 frames.
It uses the same catalogue checksum, base-relative download path and independent
IndexedDB cache as the other examples. All retained arrays were compared exactly
to the energy-enabled original. Finer temporal pressure analysis should use the
original recording rather than infer behavior between the preview frames.

SHA-256: `3bdaaa14ec3ad802307e4318b024682dbd37b9d324a6484b8590b4ffbf89c87c`.

## Regenerate and verify

Use a distinct external evidence directory for each run. Only generation needs
the working warpSPH/CUDA environment; packaging needs NumPy/h5py alone:

```bash
/path/to/warp/python examples/generate_solver_demos.py \
  --case random --nx 128 --duration 6 --interval 0.1 \
  --seed 20261017 --viscosity 0.005 \
  --output /path/to/warpSPHDevelopment/remote/new-run/random-wcsph-128

python examples/build_recorded_demos.py \
  --random /path/to/new-run/random-wcsph-128/trajectory.h5 \
  --sloshing /path/to/browser-demos/sloshing-200.h5 \
  --output /path/to/warpSPHDevelopment/remote/new-run/public-bundle

python examples/verify_demo_recording.py /path/to/random-run/trajectory.h5 \
  /path/to/public-bundle/demos/random-wcsph-128.h5
python examples/verify_demo_recording.py /path/to/browser-demos/sloshing-200.h5 \
  /path/to/public-bundle/demos/sloshing-200.h5
```

Pass `--khh /path/to/browser-demos/khh-crksph-256-energy.h5` to include KHH in
`build_recorded_demos.py`, or package only that new asset without changing the
existing two files:

```bash
python examples/prepare_demo_recording.py /path/to/khh-crksph-256-energy.h5 \
  /path/to/warpSPHDevelopment/remote/new-run/khh-crksph-256.h5 \
  --interval 0.1 --compression 9 --static-constants
python examples/verify_demo_recording.py /path/to/khh-crksph-256-energy.h5 \
  /path/to/warpSPHDevelopment/remote/new-run/khh-crksph-256.h5
```

Copy the curated bundle assets to `web/public/demos/` and its catalogue to
`web/src/recorded-demos.json`. Both generator and packaging output paths must be
new. Source files are opened read-only. GPU/runtime changes can alter floating
results, so regenerating also regenerates hashes; do not reuse stale checksums.

The current external evidence root is
`/home/lu26029/dev/warpSPHDevelopment/remote/colleague-demos-20261017/`:
`random-wcsph-128-run2/` contains the full run, `public-bundle-v1/` the package.
The original sloshing source is under `browser-demos-20261017/` beside this root.

SHA-256 for the current shipped files:

```text
d26ff393973c7ff0a5498dfebd152da3d0c9d112a603dad93a2f014f53154f8d  random-wcsph-128.h5
e77a930eefde68b338fd0fe837825cb10c58a58cb7b64d1ca257b6e0ad1af8e9  sloshing-200.h5
```

Both packages were compared against their originals at exact matching timestamps:
every retained particle, domain and diagnostic array matched, including relocated
constant supports. The 32 frontend/data tests include size/hash/HDF5-signature
checks for both shipped files, download base paths/progress, cancellation,
failed/truncated downloads and stale asset rejection. Production-build browser
checks loaded both through their demo buttons without a file picker, reconstructed
grids/streamlines and read their diagnostic histories. Random-flow refresh
restored t=3, grid mode and streamline settings with one source entry and no
duplicate download card. No browser warnings/errors were returned.

## Persistent download cache follow-up

The original implementation retained only the last selected file. Both demo
downloads now have separate, catalogue-versioned IndexedDB entries. Retaining
these is independent of the last-file checkbox and does not depend on HTTP cache
headers. See [the browser storage contract](BROWSER_FILES.md) and the concrete
no-network verification in [VERIFICATION.md](VERIFICATION.md). The original two recording assets and their hashes are unchanged. The KHH addition
uses the same cache contract; all three independent slots are covered by the cache
tests. KHH packaging and verification evidence lives in
`../warpSPHDevelopment/remote/khh-public-20261017/`.
