# Browser files, deployment and live-adapter boundary

The website is a static browser application. Local HDF5 reads happen in a worker
using [h5wasm WORKERFS](https://github.com/usnistgov/h5wasm#worker-usage), which
supports random File access without loading the whole file into a virtual disk.
There is no upload endpoint, CDN fetch, or simulator import in the default flow.

## Recommended recording layout

For fixed row identity, use:

```
/domain/min                   float64 [D]  # optional explicit box
/domain/max                   float64 [D]
/domain/periodic              uint8   [D]  # 0/1 per axis
/time                         float64 [T]
/particles/UIDs               int64   [N]
/particles/kinds              int32   [N]
/particles/masses             float32 [N]
/frames/positions             float32 [T,N,2 or 3]
/frames/velocities            float32 [T,N,2 or 3]
/frames/densities             float32 [T,N]
/frames/pressures             float32 [T,N]
/frames/supports              float32 [T,N]
/diagnostics/kineticEnergy     float64 [T]  # optional, fluid only
/diagnostics/maxSpeed          float64 [T]  # optional, fluid only
/diagnostics/meanDensity       float64 [T]  # optional, unweighted fluid mean
/diagnostics/particles         int64   [T]  # optional, fluid count
```

Optional diagnostics are used when all four arrays are present and match T.
Otherwise the reader calculates them. Times must be finite and nondecreasing;
spatial datasets must be finite nonempty N×2 or N×3. Fields are discovered from
the first frame. Units follow stored values; the UI currently does not interpret
unit attributes. Particle pressure needs a scalar recorded array (`pressures`,
or alias `pressure`); no equation of state is assumed.

Chunk dynamic datasets with **one time slice per chunk**, optionally several
spatial chunks per frame, e.g. `(1,8192,2)` or `(1,8192)`. Standard gzip/deflate
and shuffle are supported; arbitrary external HDF5 filter plugins are not. Avoid
chunks spanning the whole time axis: random scrubbing would decompress unrelated
frames. Store UID/kind/mass once only if they truly remain row-aligned and constant.
Per-frame identity arrays or nested state groups are required for reordering or
changing populations. A file containing only initial identity cannot reconstruct
unrecorded changes. The recommended stacked layout uses a fixed N.

The reader also supports native legacy warpSPH columns, nested state groups and
single checkpoints. NPZ supports numeric C-order NPY arrays, including 64-bit
IDs, either endian. Object arrays/pickles and Fortran-order arrays are rejected.
Each compressed NPZ snapshot is buffered and decompressed as a unit; HDF5 is
preferable for very large recordings. If no physical time is present, NPZ uses an
explicit frame-index axis. File selection (including optional measurements.json)
is local and must be repeated after reload. Drag/drop supports files; select a
folder with the folder picker rather than dropping a directory.

Worker memory is bounded for retained frames, not universally constant: decoded
frame buffers, temporary decompression memory, HDF5 WASM memory and GPU buffers
still matter. Browser process limits and frame size are practical constraints;
chunking cannot make an individual enormous frame free. WASM memory may retain
its high-water mark until closing the recording terminates the worker.

## Periodic display and particle traces

Coordinates are read and retained exactly as recorded. The renderer wraps only
its display buffers on periodic axes, using `/domain/{min,max,periodic}`. Native
`config/config/domain` list attributes and `config/domain` datasets are also
understood. NPZ can provide `domain_min`, `domain_max`, and `periodic` arrays in
the first snapshot. Bounds are never guessed from particle extents. Missing
metadata leaves coordinates unwrapped. The inspector exposes a display toggle;
changing it remaps the scene and refits the camera. Scalar fields and diagnostics
are unchanged. Pressure probes use minimum-image distances in declared periodic
axes independently of the display toggle.

The picked UID can be traced over n past and m future **recorded frames**, clipped
to available data (each control allows 0–1000). This is one selected UID at a time.
Each source-frame lookup uses the exact UID, rather than assuming stable row
indices. Worker batches are cancellable and lower priority than scene reads;
changing source, UID, window or frame invalidates stale results. Original unwrapped
positions are retained in trace samples. Past/future colors are distinct. Missing
UIDs create gaps, and a wrapped trace omits the segment spanning a periodic seam
rather than drawing a jump across the box. The unwrapped display draws original
continuous segments; there is no temporal interpolation or invented motion between
exports. A white marker indicates the current position when it is present.

## Hosting

`npm run build` produces `dist/`. The default relative asset base supports static
subpath hosting. `.github/workflows/pages.yml` uses GitHub's configured base path
and deploys `main`; it does not run Python. No COOP/COEP headers or shared-memory
WASM threads are required by this reader. GitHub serves the app code, while local
recordings consume neither Pages storage nor its transfer allowance.

## Later local simulation adapter

A hosted page's JavaScript runs on the viewer's device. `localhost` therefore
refers to that device. A private IP requires actual network reachability or VPN.
The current viewer **does not yet expose a live adapter connection**. The optional
Python file-service mode is a same-origin development path, not a general remote
connector.

A later adapter must handle CORS and Origin checks, browser local-network
permissions, and HTTP(S)/WS(S) compatibility. An HTTPS page to a plain local
endpoint cannot be promised uniformly across browsers. See
[MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)
and [Chrome's implementation](https://developer.chrome.com/blog/local-network-access).
Do not require users to disable browser security protections.

Display snapshots can be skipped by the proposed pull/ack protocol. A complete
live pressure history needs a separate simulation-side sampler or recording of
all desired diagnostic times; reconstructing it from skipped display snapshots
would silently lose pressure impacts. A browser disconnect must not erase that
history. This acquisition work remains separate from file/probe rendering.
