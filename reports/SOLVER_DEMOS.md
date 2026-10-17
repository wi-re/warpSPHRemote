# Recorded solver demos, 2026-10-17

The generated evidence lives outside Git in
`/home/lu26029/dev/warpSPHDevelopment/remote/browser-demos-20261017/`.
Use the top-level `khh-crksph-256.h5` and `sloshing-200.h5` in the browser picker.
No simulator installation is needed to read them or develop the website.

| Recording | Resolution | Scheme | Steps | Exported frames | Final simulated time | Size |
|---|---|---|---:|---:|---:|---:|
| KHH | 256², 65,536 fluid particles | CRKSPH | 11,070 | 161 | 3.999181509 | 194,383,008 bytes |
| Sloshing | nx=200, 10,660 particles / 4,200 fluid | deltaSPH | 70,001 | 281 | 7.000100000 | 31,679,959 bytes |

Both runs completed with `diverged=False`, no stop reason, and no velocity alarms.
Wall times including setup were 187.45 s and 458.00 s on the local RTX PRO 6000
Blackwell. These are visualization recordings, not new accuracy benchmarks or
physical validation. The solver checkout was `33d4d94ad4117ed9bc7608c10c62bc151130e6c3`;
its source and the plotting repository were not modified.

Requested export spacing was 0.025 simulation seconds. Samples carry actual
step timestamps; the initial sample is after step one and the final available
state is retained. KHH follows the runner's existing stop semantics and ends
slightly before t=4. Export threshold rounding in the initial recorder produced
some adjacent captures in the raw sloshing output; selecting the requested cadence
reduced 378 raw samples to 281 without interpolation. The recorder's threshold
calculation was corrected for regeneration.

All selected position, velocity, density, pressure, support, identity, mass and
diagnostic arrays were compared exactly against the raw recordings at the matching
timestamps. **Positions remain unwrapped.** KHH's final x extent is approximately
[-1.99987, 2.98174]. Domain metadata declares [0,1]² periodicity so the visualizer
can map its display buffers. Sloshing declares the solver's padded periodic domain
[-0.4725,-0.0225] to [0.4725,0.5305]; the stationary walls define the physical tank.
Those domain datasets were added after these runs from the case definitions;
future recordings export them directly. No coordinate array was transformed.

Raw recordings, caseSpec/summary JSON, full step diagnostics and logs remain in
`khh-crksph-256-run2/`, `sloshing-200-run2/`, and adjacent log files. The first
bootstrap attempts failed before integration with a fixed-dimension import error;
retrying the default dimension bootstrap completed both runs. An intermediate
wrapped KHH copy was superseded and is not a recommended input.

Pressure follows stored solver units. No equation of state or physical-unit
conversion is performed by the viewer. Browser IDW probes are approximate fluid
samples, not the case's boundary sensor formula or Gaussian sensor smoothing.
For sloshing, a useful test point is Sensor 1 at (-0.45,0.093) with radius 0.02;
dry portions of this fluid probe intentionally leave gaps.

Recreate with [the generation commands](README.md). Select a distinct evidence
folder for every new run. Verify a prepared file with NumPy/h5py only:

```bash
python examples/verify_demo_recording.py /path/to/raw/trajectory.h5 /path/to/demo.h5
```

## Energy-enabled KHH copy

`khh-crksph-256-energy.h5` adds global internal/total energy to a new copy of the
same KHH trajectory. `examples/add_recorded_energies.py` matches **exact** timestamps
to the same run's `diagnostics.json` thermalEnergy values. All particle arrays
remain unchanged. Total is stored kinetic plus recorded internal energy; the
browser uses this same definition. Initial internal/total energies are
3.7499976158 / 3.9094048674; final values are 3.7539203167 / 3.9094048918.
The original pressure-only demo is retained. Future recorder runs also include
per-particle specific internalEnergies when present; this existing copy contains
only the recorded global energies, not an inferred per-particle distribution.

```bash
python examples/add_recorded_energies.py /path/to/khh.h5 \
  /path/to/same-run/diagnostics.json /path/to/new-energy-copy.h5
```
