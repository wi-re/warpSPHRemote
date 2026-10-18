# Current status and useful next work

Consolidated 2026-10-18 against `c0241c6` and the current implementation/tests.
Priorities updated after user feedback: native 1D first, then durable runs and
persistent physical/performance diagnostics. Their first implementations are now
shipped; see [1D/run-library implementation and limits](ONE_DIMENSION_AND_RUN_LIBRARY.md).
This is the current feature inventory and prioritization. Other reports preserve
numerical contracts, measurements and historical verification; their original
milestone dates and test counts are not current completion claims.

The product is a browser trajectory viewer plus an optional local simulation
companion. Static file viewing works without warpSPH. Localhost and SSH forwarding
are the supported everyday connection workflow. Direct HTTPS networking exists
as an explicit opt-in, but further work on it is parked at the user's request.
No existing listener, firewall, certificate trust or running simulation is changed
by this consolidation.

## Implemented

Implemented means a code path and regression or focused manual evidence exist.
It does not mean every browser, case, resolution and solver combination has been
validated. Links give the actual scope and reproduction instructions.

| Area | What exists | Boundary / evidence |
| --- | --- | --- |
| Files and examples | Browser HDF5/NPZ readers, analytical 2D/3D demos plus a synthetic 1D contraction, curated KHH/sloshing/decay recordings and high-resolution snapshots, lazy frame reads | No solver needed; [formats](BROWSER_FILES.md), [recordings](RECORDED_DEMOS.md), [snapshots](SNAPSHOT_GALLERY.md) |
| Browser retention | Last-file copy in IndexedDB, separate verified demo caches, saved field/mapping/grid/flow/metric preferences, URL view parameters | One remembered local recording; not a full saved workspace; [views](VIEW_PRESETS_AND_ANALYSIS.md) |
| Native 1D | Canvas profile viewport, signed quantities, numerical axes, physical-boundary markers, fixed/follow axes, picking, file/live/history/video; native 1D case launch | Kidder derived duration/geometry supported; [contract and evidence](ONE_DIMENSION_AND_RUN_LIBRARY.md) |
| Particle rendering | WebGL2 2D discs/3D spheres, antialiasing, pan/zoom/orbit, clipping, periodic display mapping, exact UID picking/traces, categorical fallback | Unwrapped source coordinates preserved; [renderer](PARTICLE_ANTIALIAS.md), [controls](INTERACTION_CONTROLS.md) |
| Reconstructed fields | 2D Wendland C2/C4 normalized SPH grids, coverage masks, scalar/vector interpolation, signed vorticity and divergence, CPU and WebGPU compute | WebGL2 drawing still requires GPU readback; not general warpSPHCore operator parity; [WebGPU](WEBGPU.md), [derivatives](VELOCITY_DERIVATIVES.md) |
| Flow display | Instantaneous streamlines, picked/regular seeds, static/animated LIC, periodic seams | LIC animation displays a frozen velocity field; not unsteady pathline integration; [LIC](LIC.md) |
| Temporal material motion | Exact-UID traces, frozen neighbourhood tracking/retracking/untracking, separation and 2D local finite-time deformation fits, sampled material FTLE maps and quality layers | Recorded trajectories/history; no general LCS or asymptotic Lyapunov solver; [material analysis](MATERIAL_MOTION.md), [UX](MATERIAL_ANALYSIS_UX.md) |
| Diagnostics and probes | Configurable mass/volume/momentum/density/pressure and kinetic/thermal/total energy metrics, linked histories, fixed pressure probes and full recorded-history scans | Total energy here is kinetic + internal; live samples are bounded and can skip states; [metrics](VIEW_PRESETS_AND_ANALYSIS.md), [probes](../web/src/PressureProbes.tsx) |
| Scalar/profile analysis | Mapped-field histogram and spatial FFT/2D FFT, Cartesian/radial/angular scatter and weighted binned profiles, slices/material filters, profile CSV and FTLE JSON | Generic tools; no case-specific analytical/reference overlays; [profiles](PROFILES_AND_SIMULATION_WORKFLOWS.md), [spectra](VIEW_PRESETS_AND_ANALYSIS.md) |
| Local companion | Linux singleton, implicit local start, persistent local pairing, daemon-owned installed case catalogue, metadata-only registration, one live viewer, auto-attach/monitor, takeover/reconnect | Same workflow over SSH forwarding; no multi-user scheduler; [companion](LOCAL_COMPANION.md), [recovery](RECONNECTION.md) |
| Simulation setup | Family → case → case parameters → solver/run controls, installed solver schema bridge, sparse validated overrides, variants, launch-paused initial preview, read-only running configuration | Requires migrated solver schemas; object/array fields still use JSON controls; no saved launch templates; [configuration bridge](PROFILES_AND_SIMULATION_WORKFLOWS.md) |
| Live performance/control | Independent pause simulation / pause updates, bounded owned CPU snapshot, background encoding/publication, static revisions, time/step/ETA and transfer/RAM/GPU metrics | Copying GPU state still synchronizes; optional NVIDIA telemetry; [buffering](BUFFERED_CAPTURE_AND_VIDEO.md), [telemetry](LIVE_METRICS.md) |
| Recording and replay | Recording explicitly off by default, configurable export cadence, safe active history reads, live/history switching, finished recording replay from durable run entries | Active runs re-register; completed manifests/recording descriptors now persist; [history](LOCAL_COMPANION.md#pause-and-exported-history) |
| Durable runs and measurements | SQLite run/configuration library, managed persistent exports/logs, opt-in physical/probe and performance/resource histories, Run report and CSV | No automatic deletion/import; viewer download history remains transient; [implementation](ONE_DIMENSION_AND_RUN_LIBRARY.md) |
| Video | Offline frame range/stride and synchronized live VP8/WebM, metadata/colorbar/axes, configure t=0 before Play, render/encode ACKs, final-frame handoff and dropout holds | WebCodecs required; encoded chunks retained in browser RAM; [video](BUFFERED_CAPTURE_AND_VIDEO.md) |

## Partial features and practical gaps

These are missing pieces within existing workflows, rather than new product scope.

1. **Repeatable analyses and launch setups.** View URLs and one remembered view
   exist; profile definitions are stored by trajectory name. Camera, pressure
   probes, material selections, complete analysis definitions and launch drafts
   cannot be exported/reloaded together. A wizard draft survives dialog closure,
   but not reload. Same-name files can share profile settings unintentionally.
2. **Run-library management.** Durable manifests and recording descriptors are
   implemented and the 128-entry cap is removed. Legacy import/reindex, disk
   quotas/forecasts and export cleanup remain missing; Forget entry retains files.
3. **Case-aware validation plots.** The generic projection/profile engine exists,
   but case identity/configuration does not provide default analysis cards,
   analytical curves, literature references, error norms or derived-result
   attachments. `warpSPHCases` already has `case.yaml` figure/reference metadata;
   there is no bridge to it in this viewer. Reuse that source instead of creating
   a second browser-owned case catalogue.
4. **Measurement workflow polish.** Opt-in producer-cadence physical/probe and
   wall-clock performance/resource recording now persists without particle exports.
   Existing display-only curves remain bounded; full histories are in Run report.
   Richer saved probe setup, streamed CSV and time-weighted whole-run summaries
   remain useful follow-ups. Browser frame-download rates are not recorded by
   this producer-side recorder.
5. **Comparison and publication output.** Sources can be switched, but cannot be
   shown side by side with shared camera/time/color limits or overlaid reference
   runs. PNG currently exports the scene canvas only. Video already has a richer
   metadata compositor that can be reused for stills. No common CSV/result bundle
   covers all diagnostics/probes/histograms/spectra with provenance.
6. **Long recording/video ergonomics.** There is no export-size estimate, browser
   cache usage overview or recording disk-space forecast. Video holds compressed
   output until download; reload loses the encoder/file. There is no streaming
   sink or resumable export job. A saved trajectory is the regeneration fallback.
7. **Capability breadth.** Native 1D reading/live/history and profile display now
   exist, including compressing Kidder geometry. Generic normalized/material
   coordinates and case reference curves are still future work. Basic particles
   work in 3D; reconstructed slices/volumes and 3D flow/FTLE tools do not.
8. **Performance and maintainability.** Shared GPU rendering/compute is absent;
   GPU grids are read back for WebGL2 and streamline integration is on the CPU.
   Large particle picking scans projected particles on the main thread. The UI
   and daemon have large orchestration modules; regression coverage for complete
   browser workflows is mostly manual fixtures, not CI browser tests.

## Recommended implementation order

The first three phases below now have working implementations. Their original
requirements explain the intended scope; delivery notes identify the remaining
pieces. Subsequent phases are proposals, not completion claims.

### 1. Native 1D viewing and live integration — foundation delivered

Delivered: native acquisition/profile rendering, moving physical metadata, fixed/
follow axes, exact picking, signed fields, launch/live/history and video. Verified
on real Sod and substantially compressing Kidder. Normalized coordinates,
case-supplied analytical overlays and new driven-band classifications are not
implemented; recorded kinds stay authoritative. Other installed 1D cases are
available by catalogue/schema but are not all numerically validated by this pass.

Build a profile-first view for genuine `N×1` recordings and live snapshots, with
quantity versus physical position as the main viewport. Density, signed velocity,
pressure and specific internal energy are useful standard panels. Preserve exact
UID selection and timeline seeking, and distinguish scatter samples from an
optional sorted line: connecting across a shock or disjoint material regions
must not imply a smooth reconstructed field. Do not turn 1D into a thin fake 2D
strip or substitute speed magnitude for signed velocity.

The dimension contract must reach browser HDF5/NPZ readers, Python sources, WPR1
decoding, live captures/status, domain validation and daemon case availability.
Keep 2D grid/LIC/FTLE operations explicitly 2D. First ship recorded 1D profiles;
then exercise the same source contract through native case launch/live/history,
including initial preview, pause, export and final-state handoff.

**Moving/compressing cases are part of this milestone**, not a later polish pass:

- Separate computational domain/periodicity, physical shell or wall boundaries,
  and observed particle extent. A static config domain is not necessarily the
  occupied physical domain; initial particle bounds are not current wall positions.
- Carry time-dependent physical boundaries as numeric frame metadata, or resolve
  case-reference samples on the trusted producer/postprocessor side. Preserve
  unwrapped particle positions. Never infer physical walls from extrema or wrap
  a compressing shell using an unrelated initial interval.
- Offer fixed spatial axes and explicit follow-current-extent axes, plus optional
  case-declared normalized/material coordinates. Label any transformation and
  retain original physical coordinates/units. Reference curves and boundary
  markers must use the same actual frame time and resolved case parameters.
- Treat driven boundary bands separately when a case supplies that classification;
  do not assume all analytically driven samples already have nonfluid `kinds`.
  Keep missing boundary/reference metadata visibly unavailable.
- Use actual timestamps/adaptive dt and the resolved stopping condition. Kidder
  derives its end time during initialization and drives inner/outer boundary bands;
  a launch-form placeholder duration cannot be treated as its final target.

Acceptance fixtures: fixed-domain Sod and linear wave; reflecting/interacting
shocks such as Woodward–Colella; Noh; and Kidder through substantial compression.
Check signed velocities, changing extents/boundary positions, nonuniform times,
UID picking, fluid/band filtering and exact frame-to-profile linkage. Use a small
synthetic compressing recording for deterministic regression tests plus isolated
real solver checks. Existing 2D/3D numerical and lifecycle checks must still pass.
Case-aware analytical overlays can grow in phase 5; basic 1D reading/display must
not depend on completed `warpSPHCases` pages (Kidder's page is currently a stub).

### 2. Durable run/recording library — first implementation delivered

Delivered: persistent manifests/configuration/measurement descriptors and managed
output paths, restored finished replay/reports, storage inspection and explicit
Forget entry without deleting files. Reindex/import, export retrieval/cleanup UI
and disk quota/cadence forecasts remain follow-ups.

Persist a small run manifest and resolved launch configuration outside disposable
runtime state, with links to both physical diagnostic and performance/resource
histories, even when full particle recording was disabled. Reconcile active producers separately from completed recordings;
reopen finished history after daemon restart, expose output size/location and
provide an explicit archive/forget/cleanup workflow. Never enable recording or
remove exports implicitly. Remove the need to restart just to clear 128 entries.

Add recording size/cadence guidance and a bounded authenticated way to retrieve a
finished recording. Do not turn this into arbitrary filesystem browsing.

### 3. Persistent physical diagnostics and performance/resource histories — delivered

Delivered: opt-in scalar reductions/probes and resource/throughput samples,
transactional bounded-batch writes, finished-run report/CSV, recorded probe
provenance and history seeking. Plot statistics cover the latest 50,000 retained
rows; whole-run time-weighted aggregates and browser transfer-history ingestion
remain follow-ups. Resource timestamps/elapsed time use wall clocks, not a
cross-reboot monotonic timebase. No full profiler is claimed.

Diagnostic recording is independent of full particle recording and display pulls.
Make it lightweight and opt-in; particle trajectories remain off by default.
Persist data with the durable run manifest so finished runs can show charts,
summary statistics and CSV downloads after the viewer or daemon restarts.

Record the useful counters already available in the adapter as well as physical
quantities:

| Series | Required meaning |
| --- | --- |
| Time/step | Simulation time, actual dt, step index, active wall time, step ms and simulation-time throughput; label rolling throughput versus individual-step measurements |
| Physical reductions | Available energy, mass, momentum, density/pressure statistics and configured probes, at a simulation-time cadence |
| Host memory | Simulation-process resident RAM and separately labelled system used/total RAM |
| GPU | PID-attributed VRAM; separately labelled device used/total VRAM, utilization, power and temperature with GPU identity |
| Capture/publication | Available state-copy, encoding and adapter publication durations/bytes, including overhead when monitoring/recording is enabled |
| Viewer transfer | Optional client-reported frame bytes/download duration/rate and update interval, clearly labelled as viewer-dependent and unavailable when no viewer is attached |

Resource counters use a low wall-clock cadence (the current sampler is roughly
2 seconds), independently of physical diagnostic cadence and simulation steps.
Samples carry run ID, step/simulation time when available, monotonic elapsed time,
wall timestamp and counter scope/units. Preserve pause/capture-hold periods and
missing/unsupported counters as gaps/status, never zeros. GPU device utilization,
power and temperature are not exclusively attributable to this simulation even
when the GPU was identified by its PID. CPU step-boundary timing is not a CUDA
kernel profile. Avoid GPU synchronization merely to collect telemetry.

Finalize a bounded, append-only history plus summary on clean completion/stop:
active versus paused elapsed time, step-time distribution with its measurement
basis, peak process RAM/VRAM and available resource statistics. Do not extrapolate
an absent history or label sampled peaks as exact allocation maxima. Sample-count
and time weighting must be explicit. Flush incrementally so an interrupted run
retains its valid prefix and is labelled incomplete; avoid unbounded RAM queues.

Probe logging preserves dry/invalid gaps and includes position/frame convention,
method/radius and units. When particle recording also exists, clicking a diagnostic
sample seeks the appropriate recorded time. Without particle recording, diagnostics
remain useful but cannot recreate a missing spatial state. Persist resolved
configuration and hardware/software provenance for meaningful post-run comparisons.

Done when a completed run without a particle trajectory can be reopened after
daemon restart to inspect physical, step-time, memory and available GPU curves,
export their data and distinguish pauses, unavailable counters and missing samples.
This is resource/throughput history, not a full profiler or remote monitoring service.

### 4. Portable setup and analysis recipes

Save/load a versioned JSON recipe for launch configuration and viewer analysis.
Include camera, field/range, grid/flow settings, probes, profile definitions,
material selection/windows and source requirements. Keep credentials and file
contents out; restore incompatible fields/UIDs with explicit unavailable status.
Use the installed solver's existing configuration contract for launch recipes.

Done when a refreshed browser can restore the same setup on the same recording,
and a saved launch can be rerun without re-entering solver overrides. Existing
URL links and browser caches remain useful convenience paths.

### 5. Case-aware analysis and reference curves

Agree a small declarative analysis descriptor with `warpSPHCases`: coordinates,
field/projection, filter/binning, labels/units and optional reference/result data.
The daemon advertises installed case capabilities; recordings need enough case
and resolved-config metadata to apply them offline. Do not execute case Python in
browser inputs. More involved postprocessing should supply numeric attachments.

Start with Gresho radial velocity/pressure, TGV energy decay, a 2D shock-tube
profile and sloshing pressure histories. Validate reference parameters/units
against resolved setup; provide “unavailable” rather than a plausible wrong curve.
Then add error norms/convergence where matching reference data exists.

### 6. Comparison views and complete result export

Begin with two trajectories sharing physical time and fixed quantity range,
then shared camera and reference overlays. Handle unequal frame times explicitly.
Reuse the video compositor for a metadata-complete PNG; export plotted numerical
results with definitions, masks and source times. Add streamed/chunked video output
when long exports become a measured problem.

Alongside these phases, automate a small browser smoke suite: cached-file refresh,
launch-paused → configure → Play, pause updates independently, lease takeover,
daemon restart with a paused producer, history seek and short video finalization.
Existing isolated fixtures are the starting point. Keep generated evidence outside Git.

## Demand-led work after those workflows

- 3D reconstructed slices before general volume rendering.
- Shared WebGPU compute/render data paths, stage timings and faster picking when
  measurements identify an interaction bottleneck; preserve CPU parity/fallback.
- General point queries/CSR and selected warpSPHCore gradients/curl/Laplacians only
  with pinned numerical contracts and parity fixtures. Current normalized viewer
  derivatives are not full CRK/MLS or solver-operator equivalents.
- Independent velocity-integrated flow maps, convergence studies and validated
  ridge/LCS methods. Current material fits and scalar ridge candidates remain
  useful exploratory diagnostics, with quality masks and finite-time caveats.

## Parked / outside the current pass

Direct-IP HTTPS/certificate deployment, internet exposure, remote token lifecycle
improvements, cloud scheduling, multi-user/multi-GPU orchestration, arbitrary
simulation editing and checkpoint resume are not next milestones. Keep using
localhost/SSH forwarding. The existing explicit TLS implementation is retained,
but no further networking setup is needed for the workflow above.

## Evidence and audit scope

This consolidation inspected the source interfaces, tests and feature reports,
including `sources/client.ts`, `session.ts`, `PressureProbes.tsx`, `ProfilePlots.tsx`,
`LaunchWizard.tsx`, `renderer.ts`, `video.ts`, daemon registration/history/launch,
and the solver configuration bridge. It also checked the local
`warpSPHCases/cases/periodic/taylor-green-vortex/case.yaml` figure/reference metadata.
The reprioritization additionally inspected solver `cases/compressible/kidder.py`,
its moving-shell reference/boundary hooks, the currently stub Kidder case page,
1D rejection points throughout acquisition, and `telemetry.py`/`liveMetrics.ts`.
No simulations, new benchmarks or user daemons were run for this documentation audit.
At the audited revision CI passed Python tests, TypeScript tests and the build;
that is regression evidence, not an exhaustive browser/hardware or physics validation.
See [verification history](VERIFICATION.md) and [evidence storage](README.md).
