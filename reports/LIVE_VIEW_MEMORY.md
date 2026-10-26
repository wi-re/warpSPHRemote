# Live frame retention and disconnect investigation

On 2026-10-19 the user reported Chrome growing by roughly 50 MB per arriving
RM frame, reaching 15.4 GB of process memory, then repeatedly reconnecting.
Refreshing restored the view temporarily. The simulation continued advancing.

## Cause and change

`CompanionPanel` publishes control callbacks into parent `App` state. Its
render-scope callbacks also capture callback props created in the parent render.
The resulting historical closure chain can retain old parent render state,
including large particle snapshots. A bounded `LiveSource.current` field alone
therefore did not bound the complete viewer's memory.

The panel now routes callback props through stable callback slots, defined
outside the component render scope and updated to invoke only the latest
implementation. Control functions keep their behavior and see current parent
state, without owning the history of prior parent callback closures. No
simulator, daemon, authentication, permission or transport protocol change is
needed for this fix.

## Evidence and limits

All reproductions used isolated CPU-generated data and private localhost HTTP
fixtures. They did not attach to, pause, stop or restart the user's simulation.
The fixture emits 524,288 particles, an 18.9 MB dynamic packet and an 8.4 MB
static packet. The full app renders particles with its ordinary diagnostics
and live controls. Generated builds and probes live in
`/tmp/rm-remote-connection/`, outside source.

| Browser check | Observation |
| --- | --- |
| Decoder/LiveSource/renderer harness | 43 frames: 86 MiB JS heap, two live frame buffers; did not reproduce sustained retention |
| Existing production build, full app | 76 frames: 1,389 MiB; 745 frames: 13,424 MiB JS heap |
| Current source with only the callback fix removed, full app | 50-frame limit: 942 MiB JS heap |
| Fixed current source, full app | 55 frames: 163 MiB; 200 frames: 87 MiB JS heap |

These are Chromium `performance.memory.usedJSHeapSize` observations, not total
browser RSS or GPU memory. GC can cause temporary peaks. The controlled
baseline and fixed builds differ only by the callback-boundary change. This
confirms the retained-frame regression and its correction in this fixture;
it does not establish that every reported disconnect has the same cause.

`npm test`: 131 pass, one GC-specific test skipped in the ordinary process.
Running the new test file under `--expose-gc`: both checks pass, including
collection of replaced large callback captures. TypeScript checking and the
production build pass (existing chunk-size advice remains). Hosted delivery uses `.github/workflows/pages.yml` from `main`. Existing
browser tabs must refresh after the new build is deployed; refreshing an old
hosted bundle alone does not acquire the fix. The measurements above were
collected against local production builds before deployment.

## Reproduction

```sh
npm run build -- --outDir /tmp/remote-memory-build
node --import tsx examples/live_memory_fixture.mts --build /tmp/remote-memory-build --frames 200
node --expose-gc --import tsx --test tests/current-callback.test.ts
```

Open the printed fixture URL and choose **Watch live**. The JS-heap overlay
updates once per second. The stream offers no additional frames after its
configured limit. Stop the fixture with Ctrl+C; never substitute a real daemon
endpoint. Repeat with a build made before the callback fix to reproduce the
unbounded growth. Do not keep the leaking baseline open indefinitely.

## Chrome local-network Issues entries

The user's screenshot also shows hundreds of Local Network Access issues for
the hosted HTTPS viewer reaching a localhost HTTP daemon. Chrome applies this
policy to public-site requests to local/loopback destinations; see its
[primary documentation](https://developer.chrome.com/blog/local-network-access?hl=en).
A count of affected requests does not by itself establish that all were blocked.
The deployed client already supplies a target address-space annotation.

Keep this separate from the reproduced memory bug. On recurrence, capture the
actual failed Network request/status and Console exception as well as the
Issues entry, Chrome version and site permission state. The requested bounded
connection-event diagnostics remain tracked in the roadmap. Do not disable
browser protections, broaden daemon exposure or change permissions to hide the
notices. The interactive-element-in-summary issue is a separate markup follow-up.

Post-deployment feedback: the user reports the memory leak appears fixed in
Chrome. Their next screenshot explicitly labels 1,793 affected `session`,
`runs`, `attach`, `snapshot` and `static` requests as Blocked. These are
browser-reported blocks; fresh request timing and permission diagnostics
remain a separate unresolved investigation.
