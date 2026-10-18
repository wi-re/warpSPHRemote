# Current status and useful next work

Consolidated 2026-10-18 against `c0241c6` and the current implementation/tests.
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
| Files and examples | Browser HDF5/NPZ readers, analytical 2D/3D demos, curated KHH/sloshing/decay recordings and high-resolution snapshots, lazy frame reads | No solver needed; [formats](BROWSER_FILES.md), [recordings](RECORDED_DEMOS.md), [snapshots](SNAPSHOT_GALLERY.md) |
| Browser retention | Last-file copy in IndexedDB, separate verified demo caches, saved field/mapping/grid/flow/metric preferences, URL view parameters | One remembered local recording; not a full saved workspace; [views](VIEW_PRESETS_AND_ANALYSIS.md) |
| Particle rendering | WebGL2 2D discs/3D spheres, antialiasing, pan/zoom/orbit, clipping, periodic display mapping, exact UID picking/traces, categorical fallback | Unwrapped source coordinates preserved; [renderer](PARTICLE_ANTIALIAS.md), [controls](INTERACTION_CONTROLS.md) |
| Reconstructed fields | 2D Wendland C2/C4 normalized SPH grids, coverage masks, scalar/vector interpolation, signed vorticity and divergence, CPU and WebGPU compute | WebGL2 drawing still requires GPU readback; not general warpSPHCore operator parity; [WebGPU](WEBGPU.md), [derivatives](VELOCITY_DERIVATIVES.md) |
| Flow display | Instantaneous streamlines, picked/regular seeds, static/animated LIC, periodic seams | LIC animation displays a frozen velocity field; not unsteady pathline integration; [LIC](LIC.md) |
| Temporal material motion | Exact-UID traces, frozen neighbourhood tracking/retracking/untracking, separation and 2D local finite-time deformation fits, sampled material FTLE maps and quality layers | Recorded trajectories/history; no general LCS or asymptotic Lyapunov solver; [material analysis](MATERIAL_MOTION.md), [UX](MATERIAL_ANALYSIS_UX.md) |
| Diagnostics and probes | Configurable mass/volume/momentum/density/pressure and kinetic/thermal/total energy metrics, linked histories, fixed pressure probes and full recorded-history scans | Total energy here is kinetic + internal; live samples are bounded and can skip states; [metrics](VIEW_PRESETS_AND_ANALYSIS.md), [probes](../web/src/PressureProbes.tsx) |
| Scalar/profile analysis | Mapped-field histogram and spatial FFT/2D FFT, Cartesian/radial/angular scatter and weighted binned profiles, slices/material filters, profile CSV and FTLE JSON | Generic tools; no case-specific analytical/reference overlays; [profiles](PROFILES_AND_SIMULATION_WORKFLOWS.md), [spectra](VIEW_PRESETS_AND_ANALYSIS.md) |
| Local companion | Linux singleton, implicit local start, persistent local pairing, daemon-owned installed case catalogue, metadata-only registration, one live viewer, auto-attach/monitor, takeover/reconnect | Same workflow over SSH forwarding; no multi-user scheduler; [companion](LOCAL_COMPANION.md), [recovery](RECONNECTION.md) |
| Simulation setup | Family → case → case parameters → solver/run controls, installed solver schema bridge, sparse validated overrides, variants, launch-paused initial preview, read-only running configuration | Requires migrated solver schemas; object/array fields still use JSON controls; no saved launch templates; [configuration bridge](PROFILES_AND_SIMULATION_WORKFLOWS.md) |
| Live performance/control | Independent pause simulation / pause updates, bounded owned CPU snapshot, background encoding/publication, static revisions, time/step/ETA and transfer/RAM/GPU metrics | Copying GPU state still synchronizes; optional NVIDIA telemetry; [buffering](BUFFERED_CAPTURE_AND_VIDEO.md), [telemetry](LIVE_METRICS.md) |
| Recording and replay | Recording explicitly off by default, configurable export cadence, safe active history reads, live/history switching, finished recording replay during daemon session | Active runs re-register after restart; finished run catalogue does not persist; [history](LOCAL_COMPANION.md#pause-and-exported-history) |
| Video | Offline frame range/stride and synchronized live VP8/WebM, metadata/colorbar/axes, configure t=0 before Play, render/encode ACKs, final-frame handoff and dropout holds | WebCodecs required; encoded chunks retained in browser RAM; [video](BUFFERED_CAPTURE_AND_VIDEO.md) |

## Partial features and practical gaps

These are missing pieces within existing workflows, rather than new product scope.

1. **Repeatable analyses and launch setups.** View URLs and one remembered view
   exist; profile definitions are stored by trajectory name. Camera, pressure
   probes, material selections, complete analysis definitions and launch drafts
   cannot be exported/reloaded together. A wizard draft survives dialog closure,
   but not reload. Same-name files can share profile settings unintentionally.
2. **Durable run library.** Completed run metadata lives in the daemon registry,
   an in-memory collection capped at 128 runs. Export files can remain on disk
   while their finished run entries disappear on daemon restart. Recovery of a
   still-running producer is implemented and is a different feature. There is
   no archive/reindex/import UI, disk budget display or recording retention policy.
3. **Case-aware validation plots.** The generic projection/profile engine exists,
   but case identity/configuration does not provide default analysis cards,
   analytical curves, literature references, error norms or derived-result
   attachments. `warpSPHCases` already has `case.yaml` figure/reference metadata;
   there is no bridge to it in this viewer. Reuse that source instead of creating
   a second browser-owned case catalogue.
4. **Reliable lightweight measurements.** Live pressure/metric histories retain
   the last 600 displayed snapshots and miss skipped solver steps. Probes reset
   on source changes; their definitions/results have no dedicated portable export.
   Full recording scans work, but are an expensive substitute for solver-cadence
   pressure/energy logging when particle trajectories are intentionally disabled.
5. **Comparison and publication output.** Sources can be switched, but cannot be
   shown side by side with shared camera/time/color limits or overlaid reference
   runs. PNG currently exports the scene canvas only. Video already has a richer
   metadata compositor that can be reused for stills. No common CSV/result bundle
   covers all diagnostics/probes/histograms/spectra with provenance.
6. **Long recording/video ergonomics.** There is no export-size estimate, browser
   cache usage overview or recording disk-space forecast. Video holds compressed
   output until download; reload loses the encoder/file. There is no streaming
   sink or resumable export job. A saved trajectory is the regeneration fallback.
7. **Capability breadth.** Basic particles/clipping work in 3D; reconstructed
   slices/volumes and 3D flow/FTLE tools do not. Native 1D datasets/setups are not
   supported by the current 2D/3D viewer. That matters for genuinely 1D Sod/shock
   cases; 2D shock-strip profiles already work.
8. **Performance and maintainability.** Shared GPU rendering/compute is absent;
   GPU grids are read back for WebGL2 and streamline integration is on the CPU.
   Large particle picking scans projected particles on the main thread. The UI
   and daemon have large orchestration modules; regression coverage for complete
   browser workflows is mostly manual fixtures, not CI browser tests.

## Recommended implementation order

This is an ordered proposal, not a claim these features have been started.
Each item should ship independently, with a useful small first increment.

### 1. Portable setup and analysis recipes

Save/load a versioned JSON recipe for launch configuration and viewer analysis.
Include camera, field/range, grid/flow settings, probes, profile definitions,
material selection/windows and source requirements. Keep credentials and file
contents out; restore incompatible fields/UIDs with explicit unavailable status.
Use the installed solver's existing configuration contract for launch recipes.

Done when a refreshed browser can restore the same setup on the same recording,
and a saved launch can be rerun without re-entering solver overrides. Existing
URL links and browser caches remain useful convenience paths.

### 2. Case-aware analysis and reference curves

Agree a small declarative analysis descriptor with `warpSPHCases`: coordinates,
field/projection, filter/binning, labels/units and optional reference/result data.
The daemon advertises installed case capabilities; recordings need enough case
and resolved-config metadata to apply them offline. Do not execute case Python in
browser inputs. More involved postprocessing should supply numeric attachments.

Start with Gresho radial velocity/pressure, TGV energy decay, a 2D shock-tube
profile and sloshing pressure histories. Validate reference parameters/units
against resolved setup; provide “unavailable” rather than a plausible wrong curve.
Then add error norms/convergence where matching reference data exists.

### 3. Durable run/recording library

Persist a small run manifest and resolved launch configuration outside disposable
runtime state. Reconcile active producers separately from completed recordings;
reopen finished history after daemon restart, expose output size/location and
provide an explicit archive/forget/cleanup workflow. Never enable recording or
remove exports implicitly. Remove the need to restart just to clear 128 entries.

Add recording size/cadence guidance and a bounded authenticated way to retrieve a
finished recording. Do not turn this into arbitrary filesystem browsing.

### 4. Diagnostic recording without particle recording

Opt-in named probes/reductions sampled at a simulation-time cadence, independently
of display pulls, with lightweight durable tables and provenance. Export CSV,
retain dry/invalid gaps and map recorded timestamps to trajectory seeking when a
particle recording is also available. Define control-thread/step-boundary cost
explicitly; retain the current display-only mode as a cheap default.

This directly addresses sloshing/decay monitoring without paying for full states.

### 5. Comparison views and complete result export

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

- 1D ingestion/profile-first display when 1D benchmark cases are needed.
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
No simulations, new benchmarks or user daemons were run for this documentation audit.
At the audited revision CI passed Python tests, TypeScript tests and the build;
that is regression evidence, not an exhaustive browser/hardware or physics validation.
See [verification history](VERIFICATION.md) and [evidence storage](README.md).
