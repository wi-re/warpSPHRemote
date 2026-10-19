# Empty startup and clearing finished history

An ordinary page load starts with no selected trajectory and no viewport renderer.
The viewport's **Open trajectory** button opens the existing picker. Saved files
and their visualization preferences remain in **On this device**; refresh no
longer opens the last recording automatically. Downloaded demos retain their
separate cache. Explicit `?demo=…` share links still select their requested demo.
Service mode also lists its sources without automatically selecting the first.

Every loaded source has **Close trajectory**, including analytical demos and live
views. Closing stops playback, clears frame/selection/diagnostic state, disposes
the renderer, and returns to the empty view. Local readers are closed; analytical
examples remain selectable. The remembered local file is retained. An explicit
demo selection is removed from the URL when closed, so refresh stays blank.
Live viewing uses the existing detach-on-source-change path; closing the view
leaves execution under daemon control. An active video is finalized before the
view closes.

**Run history → Clear finished history (N)** presents an in-page confirmation
with the reviewed count. Cancel leaves entries intact. Confirm removes only
completed, failed, stopped and unregistered interrupted entries and their stored
diagnostics. Registered interrupted producers are left alone while recovering.
The daemon revalidates every removal using the existing authenticated `forget`
endpoint. Paused/running/starting simulations stay in the list; exported particle
files and logs remain on disk. The reviewed list is fixed, so a run that finishes
later is not unexpectedly included. Progress is visible; a failure stops the
batch, reports partial completion and retains the remaining entries. An attached
finished viewer is detached before its entries are cleared.

This is a frontend change using existing companion endpoints; no daemon restart
is required. Refresh the deployed viewer.

## Regeneration and evidence

```bash
npm test
npm run build
PYTHONPATH=python /path/to/warp/python examples/check_empty_view.py \
  --output /path/to/warpSPHDevelopment/remote/new-history-api
# Optional private browser fixture; never uses an existing daemon:
PYTHONPATH=python /path/to/warp/python examples/check_empty_view.py \
  --output /path/to/warpSPHDevelopment/remote/new-history-ui --browser
python -m http.server 5177 --bind 127.0.0.1 --directory dist
```

The browser fixture serves on 18771 and prints its disposable pairing token. It
contains finished entries and a paused four-particle publisher, not a solver.
It exits after 15 minutes or an output `stop.request` file. The non-browser check
verifies that finished metadata/diagnostics are forgotten, the active producer
cannot be forgotten, files are retained, and reloading the library preserves the
result. Generated recordings, logs, screenshots and fixture databases belong
outside source.

On 2026-10-19, 130 TypeScript tests and the production build passed. Browser checks
covered the initially blank viewport with zero scene canvases; explicit 2D demo
opening/closing; 1D demo share links and closing them; a local HDF5 file surviving
refresh in browser storage while the viewport stayed blank; reopening that file;
the history count/confirmation/cancellation; and closing a live four-particle
view, which left its producer paused and no longer visualized. The API fixture verified the
finished/active/file-retention boundaries. Unit tests cover partial failures and
the reviewed-list boundary. Native browser confirmation initially blocked the
automation connection; the final UI uses an in-page confirmation instead.
