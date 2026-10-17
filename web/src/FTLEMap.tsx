import { useEffect, useRef, useState } from "react";
import type { Source } from "./types";
import type { TrajectorySource } from "./sources/client";
import { ridgeMask, type FTLEQuery, type FTLEBatch } from "./sources/ftle";
import { ftleSummary } from "./ftleDisplay";
import { paletteBytes } from "./palettes";
interface FTLEMapResult extends FTLEBatch {
  query: FTLEQuery;
  sourceId: string;
  sourceName: string;
  times: number[];
}
export function FTLEMap({
  source,
  reader,
  seedIndex,
  endIndex,
  radius,
  neighbours,
  onClose,
  onPick,
}: {
  source: Source;
  reader: TrajectorySource;
  seedIndex: number;
  endIndex: number;
  radius: number;
  neighbours: number;
  onClose: () => void;
  onPick: (uid: string, index: number) => void;
}) {
  const [query, setQuery] = useState<FTLEQuery>({
      start: Math.min(seedIndex, source.frames - 2),
      end:
        endIndex === seedIndex
          ? seedIndex === source.frames - 1
            ? seedIndex
            : Math.min(source.frames - 1, seedIndex + 10)
          : endIndex,
      resolution: 64,
      radius,
      neighbours: Math.max(3, neighbours),
      maxResidual: 0.25,
    }),
    [result, setResult] = useState<FTLEMapResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ridges, setRidges] = useState(false),
    [threshold, setThreshold] = useState(0),
    [hover, setHover] = useState(""),
    [mapDisplay, setMapDisplay] = useState<"ftle" | "residual" | "acceptance">(
      "ftle",
    ),
    [contrast, setContrast] = useState<"full" | "robust">("full"),
    [largeMap, setLargeMap] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    abort = useRef<AbortController | null>(null),
    dialog = useRef<HTMLDialogElement>(null),
    openFocus = useRef<Element | null>(null);
  useEffect(() => {
    openFocus.current = document.activeElement;
    dialog.current?.showModal();
    return () => {
      abort.current?.abort();
      if (openFocus.current instanceof HTMLElement) openFocus.current.focus();
    };
  }, []);
  const generate = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      let full: FTLEMapResult | undefined;
      for (let offset = 0, total = 1; offset < total; offset += 128) {
        const batch = await reader.ftle(query, offset, 128, controller.signal);
        controller.signal.throwIfAborted();
        total = batch.width * batch.height;
        full ??= {
          ...batch,
          offset: 0,
          values: new Float32Array(total).fill(NaN),
          residual: new Float32Array(total).fill(NaN),
          condition: new Float32Array(total).fill(NaN),
          counts: new Uint8Array(total),
          uids: Array(total).fill(null),
          query: { ...query },
          sourceId: source.id,
          sourceName: source.name,
          times: [source.times[query.start], source.times[query.end]],
        };
        full.values.set(batch.values, offset);
        full.residual.set(batch.residual, offset);
        full.condition.set(batch.condition, offset);
        full.counts.set(batch.counts, offset);
        full.uids.splice(offset, batch.uids.length, ...batch.uids);
        full.offset = offset + batch.values.length;
        // Snapshot every eight batches to bound UI work; every job yields to playback.
        if (offset % 1024 === 0 || full.offset === total)
          setResult({
            ...full,
            values: full.values.slice(),
            residual: full.residual.slice(),
            condition: full.condition.slice(),
            counts: full.counts.slice(),
            uids: [...full.uids],
          });
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const summary = result ? ftleSummary(result, result.query.maxResidual) : null;
  const lo = mapDisplay === "ftle" ? (summary?.min ?? 0) : 0;
  const hi =
    mapDisplay === "ftle"
      ? ((contrast === "robust" ? summary?.p95 : summary?.max) ?? 1)
      : mapDisplay === "residual"
        ? Math.max(
            result?.query.maxResidual ?? 0.25,
            ...Array.from(result?.residual ?? []).filter(Number.isFinite),
          )
        : 1;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const number = (v: number) =>
    Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : "—";
  useEffect(() => {
    if (!canvas.current || !result) return;
    const { width: w, height: h, values } = result;
    canvas.current.width = w;
    canvas.current.height = h;
    const context = canvas.current.getContext("2d")!,
      image = context.createImageData(w, h),
      palette = paletteBytes("inferno"),
      mask = ridges ? ridgeMask(values, w, h, threshold) : null;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          off = ((h - 1 - y) * w + x) * 4;
        const value =
          mapDisplay === "residual" ? result.residual[i] : values[i];
        const checker = (x + y) % 2 ? [60, 72, 85, 255] : [43, 54, 66, 255];
        if (i >= result.offset || !Number.isFinite(value)) {
          image.data.set(checker, off);
          continue;
        }
        if (mapDisplay === "acceptance") {
          image.data.set([117, 221, 186, 255], off);
          continue;
        }
        const j =
          Math.min(
            255,
            Math.max(
              0,
              Math.round(((value - lo) / Math.max(hi - lo, 1e-20)) * 255),
            ),
          ) * 4;
        image.data.set(
          mapDisplay === "ftle" && mask?.[i]
            ? [106, 255, 224, 255]
            : [palette[j], palette[j + 1], palette[j + 2], 255],
          off,
        );
      }
    context.putImageData(image, 0, 0);
  }, [result, lo, hi, ridges, threshold, mapDisplay]);
  const at = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return -1;
    const box = event.currentTarget.getBoundingClientRect(),
      x = Math.floor(((event.clientX - box.left) / box.width) * result.width),
      y =
        result.height -
        1 -
        Math.floor(((event.clientY - box.top) / box.height) * result.height);
    return x < 0 || x >= result.width || y < 0 || y >= result.height
      ? -1
      : y * result.width + x;
  };
  const save = () => {
    if (!result) return;
    const blob = new Blob(
        [
          JSON.stringify(
            {
              ...result,
              values: Array.from(result.values, (v) =>
                Number.isFinite(v) ? v : null,
              ),
              residual: Array.from(result.residual, (v) =>
                Number.isFinite(v) ? v : null,
              ),
              condition: Array.from(result.condition, (v) =>
                Number.isFinite(v) ? v : null,
              ),
              counts: Array.from(result.counts),
              complete: result.offset === result.width * result.height,
              algorithm:
                "nearest-material-center, center-anchored uniform least-squares, seed periodic branches + unwrapped displacement",
              coordinateConvention:
                "grid at t0; physical source length/time units",
              conditionLimit: 1e6,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "warpsph-material-ftle.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <dialog
      ref={dialog}
      className="ftle-dialog"
      aria-labelledby="ftle-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id="ftle-title">Finite-time stretching · FTLE</h2>
          <p>{source.name} · sampled at initial material coordinates</p>
        </div>
        <button aria-label="Close FTLE map" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="ftle-intro">
        Where do nearby particles separate most? Bright colors show stronger
        stretching over the chosen time interval, located at the particles’{" "}
        <strong>initial positions</strong>. This is a material estimate from
        recorded particle motion.
      </p>
      <div className="material-toolbar">
        {(["start", "end"] as const).map((key) => (
          <label key={key}>
            {key === "start" ? "Initial frame" : "Final frame"}
            <input
              type="number"
              aria-label={`FTLE ${key} frame`}
              min="1"
              max={source.frames}
              value={query[key] + 1}
              onChange={(e) => {
                const n = +e.target.value;
                if (Number.isInteger(n) && n >= 1 && n <= source.frames)
                  setQuery({ ...query, [key]: n - 1 });
              }}
            />
          </label>
        ))}
        <label>
          Map resolution
          <select
            aria-label="FTLE resolution"
            value={query.resolution}
            onChange={(e) =>
              setQuery({
                ...query,
                resolution: +e.target.value as FTLEQuery["resolution"],
              })
            }
          >
            {[32, 64, 128].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Neighbour radius
          <input
            aria-label="FTLE radius"
            type="number"
            min="0.000001"
            step="0.01"
            value={query.radius}
            onChange={(e) => {
              if (+e.target.value > 0)
                setQuery({ ...query, radius: +e.target.value });
            }}
          />
        </label>
        <label>
          Max. neighbours
          <input
            aria-label="FTLE neighbours"
            type="number"
            min="3"
            max="64"
            value={query.neighbours}
            onChange={(e) => {
              const n = +e.target.value;
              if (Number.isInteger(n) && n >= 3 && n <= 64)
                setQuery({ ...query, neighbours: n });
            }}
          />
        </label>
        <label>
          Max. fit residual
          <input
            aria-label="FTLE residual limit"
            type="number"
            min="0.01"
            max="1"
            step="0.05"
            value={query.maxResidual}
            onChange={(e) => {
              const n = +e.target.value;
              if (n > 0 && n <= 1) setQuery({ ...query, maxResidual: n });
            }}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void generate()}
        >
          Generate map
        </button>
        {busy && (
          <button
            onClick={() => {
              abort.current?.abort();
              setBusy(false);
            }}
          >
            Cancel map
          </button>
        )}
        {result && <button onClick={save}>Export analysis</button>}
      </div>
      {result && summary ? (
        <>
          <div className="ftle-summary" role="status">
            <div>
              <small>
                {result.times[1] > result.times[0] ? "Forward" : "Backward"}{" "}
                interval
              </small>
              <strong>
                t={number(result.times[0])} → {number(result.times[1])}
              </strong>
              <small>
                Δt = {number(Math.abs(result.times[1] - result.times[0]))} ·{" "}
                {result.query.start + 1} → {result.query.end + 1} frames
              </small>
            </div>
            <div>
              <small>Accepted fits</small>
              <strong>
                {(
                  (100 * summary.valid) /
                  Math.max(1, summary.processed)
                ).toFixed(1)}
                %
              </strong>
              <small>
                {summary.valid.toLocaleString()} /{" "}
                {summary.processed.toLocaleString()} evaluated cells
              </small>
            </div>
            <div>
              <small>Masked / untrusted</small>
              <strong>{summary.masked.toLocaleString()} cells</strong>
              <small>
                {summary.pending
                  ? `${summary.pending.toLocaleString()} still computing`
                  : "Not zero stretching"}
              </small>
            </div>
          </div>
          <div className="ftle-display-controls">
            <button
              className="secondary-button"
              aria-pressed={largeMap}
              onClick={() => setLargeMap((v) => !v)}
            >
              {largeMap ? "Fit map to window" : "Enlarge map"}
            </button>
            <label>
              Map layer{" "}
              <select
                aria-label="FTLE map layer"
                value={mapDisplay}
                onChange={(e) =>
                  setMapDisplay(e.target.value as typeof mapDisplay)
                }
              >
                <option value="ftle">Stretching · FTLE</option>
                <option value="residual">
                  Fit residual · including rejected fits
                </option>
                <option value="acceptance">Accepted fit coverage</option>
              </select>
            </label>
            {mapDisplay === "ftle" && (
              <label>
                Color range{" "}
                <select
                  aria-label="FTLE color range"
                  value={contrast}
                  onChange={(e) =>
                    setContrast(e.target.value as typeof contrast)
                  }
                >
                  <option value="full">Full numerical range</option>
                  <option value="robust">Clip brightest 5% for contrast</option>
                </select>
              </label>
            )}
          </div>
        </>
      ) : null}
      <div className="ftle-preview">
        {result ? (
          <div
            className="ftle-map-layout"
            style={{
              width: largeMap
                ? "min(100%,650px)"
                : "min(100%,calc(30vh + 60px))",
            }}
          >
            <div className="ftle-y-title">Initial y [length]</div>
            <div className="ftle-y-ticks">
              {ticks.map((t) => (
                <span key={t}>
                  {number(
                    result.bounds[1][1] -
                      t * (result.bounds[1][1] - result.bounds[0][1]),
                  )}
                </span>
              ))}
            </div>
            <div
              className="ftle-raster"
              style={{
                aspectRatio:
                  (result.bounds[1][0] - result.bounds[0][0]) /
                  (result.bounds[1][1] - result.bounds[0][1]),
              }}
            >
              <canvas
                ref={canvas}
                aria-label="FTLE field at initial material coordinates"
                onMouseLeave={() => setHover("")}
                onMouseMove={(e) => {
                  const i = at(e);
                  if (i < 0) return;
                  const x =
                    result.bounds[0][0] +
                    (((i % result.width) + 0.5) / result.width) *
                      (result.bounds[1][0] - result.bounds[0][0]);
                  const y =
                    result.bounds[0][1] +
                    ((Math.floor(i / result.width) + 0.5) / result.height) *
                      (result.bounds[1][1] - result.bounds[0][1]);
                  const v = result.values[i];
                  const info = Number.isFinite(v)
                    ? `FTLE ${number(v)} [1/time] · stretch factor ≈ ${number(Math.exp(v * Math.abs(result.times[1] - result.times[0])))}×`
                    : "Masked: no trusted stretching estimate";
                  setHover(
                    `x=${number(x)}, y=${number(y)} · ${info} · UID ${result.uids[i] ?? "none"} · ${result.counts[i]} neighbours · residual ${number(result.residual[i])}`,
                  );
                }}
                onClick={(e) => {
                  const i = at(e),
                    uid = i >= 0 ? result.uids[i] : null;
                  if (uid) {
                    onPick(uid, result.query.start);
                    onClose();
                  }
                }}
              />
            </div>
            <div className="ftle-x-ticks">
              {ticks.map((t) => (
                <span key={t}>
                  {number(
                    result.bounds[0][0] +
                      t * (result.bounds[1][0] - result.bounds[0][0]),
                  )}
                </span>
              ))}
            </div>
            <div className="ftle-x-title">Initial x [length]</div>
          </div>
        ) : (
          <div className="ftle-empty">
            Choose a start and end frame, then Generate map.
            <br />
            Use a short interval first; long intervals can make local fits
            unreliable.
          </div>
        )}
      </div>
      {result && (
        <>
          <div className="ftle-legend">
            {mapDisplay !== "acceptance" ? (
              <>
                <span>{number(lo)}</span>
                <div className="ftle-colorbar" />
                <span>
                  {number(hi)}{" "}
                  {mapDisplay === "ftle" ? "[1/time]" : "relative residual"}
                </span>
              </>
            ) : (
              <span className="ftle-valid-key">Accepted fit</span>
            )}
            <span className="ftle-mask-key">Masked / unavailable</span>
          </div>
          <p className="ftle-caption">
            {mapDisplay === "ftle"
              ? "Dark = weak stretching · bright = strong stretching. Negative values indicate contraction."
              : mapDisplay === "residual"
                ? "Smaller residual = a closer local deformation fit. Values above the fit limit are excluded from FTLE."
                : "Green cells passed the fit checks; patterned cells did not."}
            {contrast === "robust" && mapDisplay === "ftle"
              ? " Values above the 95th percentile share the brightest color; numerical values are unchanged."
              : ""}
          </p>
          {summary && summary.masked > 0 && (
            <div className="ftle-mask-explanation">
              <strong>Why are there gaps?</strong>
              <p>
                {summary.noParticle.toLocaleString()} no sampled particle ·{" "}
                {summary.fewMatches.toLocaleString()} insufficient matches ·{" "}
                {summary.residual.toLocaleString()} above residual limit ·{" "}
                {summary.unavailable.toLocaleString()} unstable or unavailable
                fits.
              </p>
              <p>
                Patterned regions are not evidence of low stretching. Try a
                shorter interval and inspect the residual layer. Relaxing the
                residual limit admits less reliable fits.
              </p>
            </div>
          )}
          <p className="ftle-hover">
            {hover ||
              "Hover to inspect coordinates, stretching and fit quality. Click a sampled particle to select it in the main viewer."}
          </p>
        </>
      )}
      <div className="ftle-caption" role="status">
        {busy
          ? `Computing ${summary?.processed ?? 0} / ${summary?.total ?? "…"} cells…`
          : result && JSON.stringify(query) !== JSON.stringify(result.query)
            ? "Settings changed. Generate map to update the result."
            : ""}
      </div>
      <details className="ftle-advanced">
        <summary>Ridge candidates and method details</summary>
        <div className="material-toolbar">
          <label className="flow-toggle">
            <input
              type="checkbox"
              aria-label="Show FTLE ridge candidates"
              checked={ridges}
              onChange={(e) => setRidges(e.target.checked)}
            />
            Scalar ridge candidates
          </label>
          {ridges && (
            <label>
              Minimum FTLE
              <input
                type="number"
                aria-label="FTLE ridge threshold"
                step="0.1"
                value={threshold}
                onChange={(e) => {
                  if (Number.isFinite(+e.target.value))
                    setThreshold(+e.target.value);
                }}
              />
            </label>
          )}
        </div>
        <p className="subtle-note">
          Forward/backward finite-time fits use exact UIDs and original
          unwrapped motion. Missing identities, rank loss, condition &gt; 10⁶,
          and excessive residual are masked. The raster samples the nearest
          recorded fluid center within 1.5 cell diagonals and the search radius.
          Ridge candidates are coordinate-axis local maxima above a threshold;
          they are not a validated material LCS. Sparse exports and particle
          shifting affect interpretation.
        </p>
      </details>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
