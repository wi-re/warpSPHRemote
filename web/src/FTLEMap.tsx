import { useEffect, useRef, useState } from "react";
import type { Source } from "./types";
import type { TrajectorySource } from "./sources/client";
import { ridgeMask, type FTLEQuery, type FTLEBatch } from "./sources/ftle";
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
      start: seedIndex,
      end:
        endIndex === seedIndex
          ? Math.min(source.frames - 1, seedIndex + 10)
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
    [hover, setHover] = useState("");
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
  const finite = result
      ? Array.from(result.values).filter(Number.isFinite)
      : [],
    lo = finite.length ? Math.min(...finite) : 0,
    hi = finite.length ? Math.max(...finite) : 1;
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
        if (!Number.isFinite(values[i])) {
          image.data.set([24, 33, 41, 255], off);
          continue;
        }
        const j =
          Math.min(
            255,
            Math.max(
              0,
              Math.round(((values[i] - lo) / Math.max(hi - lo, 1e-20)) * 255),
            ),
          ) * 4;
        image.data.set(
          mask?.[i]
            ? [106, 255, 224, 255]
            : [palette[j], palette[j + 1], palette[j + 2], 255],
          off,
        );
      }
    context.putImageData(image, 0, 0);
  }, [result, lo, hi, ridges, threshold]);
  const at = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return -1;
    const box = event.currentTarget.getBoundingClientRect(),
      w = Math.min(box.width, (box.height * result.width) / result.height),
      h = (w * result.height) / result.width,
      x = Math.floor(
        ((event.clientX - box.left - (box.width - w) / 2) / w) * result.width,
      ),
      y =
        result.height -
        1 -
        Math.floor(
          ((event.clientY - box.top - (box.height - h) / 2) / h) *
            result.height,
        );
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
          <h2 id="ftle-title">Material FTLE map · 2D</h2>
          <p>{source.name} · sampled at initial material coordinates</p>
        </div>
        <button aria-label="Close FTLE map" onClick={onClose}>
          ×
        </button>
      </header>
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
      <div className="ftle-preview">
        <canvas
          ref={canvas}
          aria-label="FTLE field at initial material coordinates"
          onMouseMove={(e) => {
            const i = at(e);
            if (i < 0 || !result) return;
            setHover(
              `UID ${result.uids[i] ?? "—"} · FTLE ${Number.isFinite(result.values[i]) ? result.values[i].toPrecision(5) : "masked"} · ${result.counts[i]} matched · residual ${result.residual[i].toPrecision(3)} · condition ${result.condition[i].toPrecision(3)}`,
            );
          }}
          onClick={(e) => {
            const i = at(e),
              uid = i >= 0 ? result?.uids[i] : null;
            if (uid && result) {
              onPick(uid, result.query.start);
              onClose();
            }
          }}
        />
      </div>
      <div className="ftle-caption" role="status">
        {result
          ? `${result.offset}/${result.width * result.height} cells · ${finite.length} valid · t₀=${result.times[0].toPrecision(5)} → t₁=${result.times[1].toPrecision(5)} · FTLE ${lo.toPrecision(4)} … ${hi.toPrecision(4)} [1/time]`
          : "Choose two recorded instants and generate a map."}
        {busy ? " · computing…" : ""}
      </div>
      {result && (
        <div className="ftle-legend">
          <span>{lo.toPrecision(4)}</span>
          <div />
          <span>{hi.toPrecision(4)} [1/time]</span>
          <span>
            x=[{result.bounds[0][0]}, {result.bounds[1][0]}] · y=[
            {result.bounds[0][1]}, {result.bounds[1][1]}]
          </span>
        </div>
      )}
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
        {hover ||
          "Hover for fit quality; click a sampled material center to inspect it in the viewer."}
      </p>
      <p className="subtle-note">
        Forward/backward finite-time fits use exact UIDs and original unwrapped
        motion. Missing identities, rank loss, condition &gt; 10⁶, and excessive
        residual are masked. The raster samples the nearest recorded fluid
        center within 1.5 cell diagonals and the search radius. Ridge candidates
        are coordinate-axis local maxima above a threshold; they are not a
        validated material LCS. Sparse exports and particle shifting affect
        interpretation.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
