import { useEffect, useMemo, useRef, useState } from "react";
import type { TrajectorySource } from "./sources/client";
import type { Source } from "./types";
import {
  deformation,
  type MaterialSeed,
  type MaterialSample,
  type NeighbourSettings,
} from "./sources/material";
import { loadPlotly, resizeVisiblePlot } from "./Chart";
export function useMaterialMotion(
  reader: TrajectorySource | undefined,
  source: Source | undefined,
) {
  const [seed, setSeed] = useState<MaterialSeed | null>(null),
    [rows, setRows] = useState<MaterialSample[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [past, setPast] = useState(20),
    [future, setFuture] = useState(20),
    [visible, setVisible] = useState(true),
    [fade, setFade] = useState(true),
    [ellipse, setEllipse] = useState(true),
    [pinned, setPinned] = useState<string[]>([]),
    [settings, setSettings] = useState<NeighbourSettings>({
      mode: "nearest",
      count: 24,
      radius: 0.05,
    }),
    [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null),
    cache = useRef(new Map<number, MaterialSample>()),
    generation = useRef(0);
  useEffect(() => {
    generation.current++;
    active.current?.abort();
    cache.current.clear();
    setSeed(null);
    setRows([]);
    setPinned([]);
    setBusy(false);
    setError("");
  }, [source?.id]);
  useEffect(() => () => active.current?.abort(), []);
  const clear = () => {
    generation.current++;
    active.current?.abort();
    cache.current.clear();
    setSeed(null);
    setRows([]);
    setBusy(false);
  };
  const capture = async (index: number, uid: string) => {
    if (!reader || !source || !uid) return;
    const token = ++generation.current;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    setBusy(true);
    setError("");
    setRows([]);
    setSeed(null);
    cache.current.clear();
    try {
      const result = await reader.materialSeed(
        index,
        uid,
        settings,
        pinned,
        abort.signal,
      );
      if (token !== generation.current) return;
      cache.current.set(index, {
        index,
        time: result.time,
        positions: result.positions,
      });
      setSeed(result);
    } catch (e) {
      if (!abort.signal.aborted) {
        setError((e as Error).message);
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!seed || !source || !reader) return;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    const start = Math.max(0, seed.index - past),
      end = Math.min(source.frames - 1, seed.index + future);
    const publish = () =>
      setRows(
        [...cache.current.values()]
          .filter((r) => r.index >= start && r.index <= end)
          .sort((a, b) => a.index - b.index),
      );
    publish();
    setBusy(true);
    setError("");
    (async () => {
      // Seed-outward order gives early local results. One frame per job yields to playback.
      const order = Array.from(
        { length: end - start + 1 },
        (_, i) => start + i,
      ).sort((a, b) => Math.abs(a - seed.index) - Math.abs(b - seed.index));
      for (const i of order) {
        if (cache.current.has(i)) continue;
        const [row] = await reader.material(i, 1, seed.uids, abort.signal);
        abort.signal.throwIfAborted();
        cache.current.set(i, row);
        if (cache.current.size > 1001) {
          const key = [...cache.current.keys()].find(
            (k) => k < start || k > end,
          );
          if (key != null) cache.current.delete(key);
        }
        publish();
      }
    })()
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [seed, reader, source?.id, past, future, revision]);
  const analyses = useMemo(
    () =>
      seed
        ? rows.map((row) => ({
            ...deformation(seed, row, 0.25),
            index: row.index,
            time: row.time,
          }))
        : [],
    [seed, rows],
  );
  return {
    seed,
    rows,
    busy,
    error,
    past,
    setPast,
    future,
    setFuture,
    settings,
    setSettings,
    visible,
    setVisible,
    fade,
    setFade,
    ellipse,
    setEllipse,
    pinned,
    add: (uid: string) =>
      setPinned((old) =>
        old.includes(uid) || old.length >= 8 ? old : [...old, uid],
      ),
    clearPinned: () => setPinned([]),
    capture,
    clear,
    analyses,
    complete:
      !!seed &&
      rows.length ===
        Math.min((source?.frames ?? 1) - 1, seed.index + future) -
          Math.max(0, seed.index - past) +
          1,
    cancel: () => {
      active.current?.abort();
      setBusy(false);
    },
    resume: () => setRevision((v) => v + 1),
  };
}
export type MaterialController = ReturnType<typeof useMaterialMotion>;
export function MaterialCapture({
  motion: m,
  index,
  uid,
  supported,
  onOpen,
}: {
  motion: MaterialController;
  index: number;
  uid: string;
  supported: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="material-capture">
      <button
        className="secondary-button"
        disabled={!supported || !uid}
        onClick={() => {
          void m.capture(index, uid);
          onOpen();
        }}
      >
        Track neighbourhood
      </button>
      <button
        className="secondary-button"
        disabled={
          !supported || !uid || m.pinned.includes(uid) || m.pinned.length >= 8
        }
        onClick={() => m.add(uid)}
      >
        Pin seed ({m.pinned.length}/8)
      </button>
      <p className="subtle-note">
        Pinned seeds join the next captured material set.
      </p>
    </div>
  );
}
export function MaterialTools({
  motion: m,
  index,
  timeKind,
}: {
  motion: MaterialController;
  index: number;
  timeKind?: string;
}) {
  const current = m.analyses.find((row) => row.index === index),
    available =
      m.rows.find((row) => row.index === index)?.positions.filter(Boolean)
        .length ?? 0;
  return (
    <section className="material-tools" aria-label="Material motion controls">
      <div className="material-toolbar">
        <label>
          Neighbour selection
          <select
            aria-label="Neighbour selection"
            value={m.settings.mode}
            onChange={(e) =>
              m.setSettings({
                ...m.settings,
                mode: e.target.value as NeighbourSettings["mode"],
              })
            }
          >
            <option value="nearest">Nearest fluid particles</option>
            <option value="radius">Within radius</option>
            <option value="support">Within seed support</option>
          </select>
        </label>
        <label>
          Max. neighbours
          <input
            aria-label="Maximum material neighbours"
            type="number"
            min="1"
            max="64"
            value={m.settings.count}
            onChange={(e) => {
              const n = +e.target.value;
              if (Number.isInteger(n) && n > 0 && n <= 64)
                m.setSettings({ ...m.settings, count: n });
            }}
          />
        </label>
        {m.settings.mode === "radius" && (
          <label>
            Radius
            <input
              aria-label="Material radius"
              type="number"
              min="0.000001"
              step="0.01"
              value={m.settings.radius}
              onChange={(e) => {
                if (+e.target.value > 0)
                  m.setSettings({ ...m.settings, radius: +e.target.value });
              }}
            />
          </label>
        )}
        {(["past", "future"] as const).map((key) => (
          <label key={key}>
            {key === "past" ? "Past frames" : "Future frames"}
            <input
              aria-label={`Material ${key} frames`}
              type="number"
              min="0"
              max="500"
              value={m[key]}
              onChange={(e) => {
                const n = +e.target.value;
                if (Number.isInteger(n) && n >= 0 && n <= 500)
                  (key === "past" ? m.setPast : m.setFuture)(n);
              }}
            />
          </label>
        ))}
        <label className="flow-toggle">
          <input
            aria-label="Show material tracks"
            type="checkbox"
            checked={m.visible}
            onChange={(e) => m.setVisible(e.target.checked)}
          />
          Tracks
        </label>
        <label className="flow-toggle">
          <input
            aria-label="Fade material tracks"
            type="checkbox"
            checked={m.fade}
            onChange={(e) => m.setFade(e.target.checked)}
          />
          Fade
        </label>
        <label className="flow-toggle">
          <input
            aria-label="Show deformation ellipse"
            type="checkbox"
            checked={m.ellipse}
            onChange={(e) => m.setEllipse(e.target.checked)}
          />
          Fit ellipse
        </label>
        {m.busy ? (
          <button onClick={m.cancel}>Pause analysis</button>
        ) : (
          m.seed &&
          !m.complete && <button onClick={m.resume}>Resume analysis</button>
        )}
        {m.seed && <button onClick={m.clear}>Clear material set</button>}
        {m.pinned.length > 0 && (
          <button onClick={m.clearPinned}>Clear pinned seeds</button>
        )}
      </div>
      <div className="material-quality" role="status">
        {m.seed
          ? `Frozen UID ${m.seed.uids[0]} at frame ${m.seed.index + 1} · t=${m.seed.time.toPrecision(5)} · ${m.seed.uids.length} UIDs · ${m.rows.length} frames ${m.busy ? "· reading…" : ""} · ${available}/${m.seed.uids.length} present in current frame`
          : "Pick a particle, then Track neighbourhood. Selection changes apply to the next capture."}
        {current && (
          <span>
            {" "}
            Matched neighbours: {current.neighbours} · RMS radius:{" "}
            {current.rmsSeparation?.toPrecision(4) ?? "—"} · {current.direction}{" "}
            Δt={current.duration.toPrecision(4)} · FTLE:{" "}
            {timeKind === "simulation"
              ? (current.ftle?.toPrecision(4) ?? "—")
              : "unavailable without physical time"}{" "}
            · condition: {current.condition?.toPrecision(3) ?? "—"} · relative
            residual: {current.residual?.toPrecision(3) ?? "—"}
            {current.reason ? ` · ${current.reason}` : ""}
          </span>
        )}
        {m.error && (
          <span className="inline-error" role="alert">
            {m.error}
          </span>
        )}
      </div>
    </section>
  );
}
export function MaterialChart({
  motion: m,
  source,
  index,
  onSeek,
  theme,
}: {
  motion: MaterialController;
  source: Source;
  index: number;
  onSeek: (index: number) => void;
  theme: "dark" | "light";
}) {
  const ref = useRef<HTMLDivElement>(null),
    seek = useRef(onSeek);
  seek.current = onSeek;
  const [quantity, setQuantity] = useState<"rmsSeparation" | "ftle">(
    "rmsSeparation",
  );
  useEffect(() => {
    const element = ref.current!;
    let stopped = false,
      observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (stopped) return;
      observer = new ResizeObserver(() => {
        if (!stopped) resizeVisiblePlot(P, element);
      });
      observer.observe(element);
    });
    return () => {
      stopped = true;
      observer?.disconnect();
      loadPlotly().then((P) => P.purge(element));
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    loadPlotly().then(async (P) => {
      if (stopped || !ref.current) return;
      const el = ref.current as any,
        light = theme === "light";
      await P.react(
        el,
        [
          {
            type: "scatter",
            mode: "lines+markers",
            x: m.analyses.map((r) => r.time),
            y: m.analyses.map((r) =>
              quantity === "ftle" && source.timeKind !== "simulation"
                ? null
                : r[quantity],
            ),
            customdata: m.analyses.map((r) => r.index),
            connectgaps: false,
            marker: { size: 4 },
            line: { color: light ? "#187c5c" : "#75ddba" },
            hovertemplate: "t=%{x:.5g}<br>%{y:.5g}<extra></extra>",
          },
        ],
        {
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: {
            family: "Inter,system-ui",
            size: 10,
            color: light ? "#526776" : "#8394a5",
          },
          margin: { l: 65, r: 20, t: 10, b: 30 },
          showlegend: false,
          xaxis: {
            title: {
              text:
                source.timeKind === "simulation"
                  ? "Simulation time"
                  : "Frame index",
            },
            gridcolor: light ? "#cbd7df" : "#26313b",
            range: [source.times[0], source.times.at(-1)],
          },
          yaxis: {
            title: {
              text:
                quantity === "ftle" ? "FTLE [1/time]" : "RMS radius [length]",
            },
            gridcolor: light ? "#cbd7df" : "#26313b",
            zeroline: false,
          },
          shapes: [
            {
              type: "line",
              xref: "x",
              yref: "paper",
              x0: source.times[index],
              x1: source.times[index],
              y0: 0,
              y1: 1,
              line: { color: "#8b9bac", dash: "dot", width: 1 },
            },
          ],
          uirevision: source.id + quantity + m.seed?.index,
        },
        { responsive: true, displayModeBar: false },
      );
      if (stopped) return;
      el.removeAllListeners?.("plotly_click");
      el.on("plotly_click", (e: any) => {
        const i = e.points?.[0]?.customdata;
        if (Number.isInteger(i)) seek.current(i);
      });
    });
    return () => {
      stopped = true;
    };
  }, [m.analyses, m.seed, quantity, source, index, theme]);
  return (
    <div className="material-chart">
      <label>
        Material diagnostic
        <select
          aria-label="Material diagnostic"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value as typeof quantity)}
        >
          <option value="rmsSeparation">Neighbourhood RMS radius</option>
          <option
            value="ftle"
            disabled={
              source.timeKind !== "simulation" || source.dimension !== 2
            }
          >
            Local deformation FTLE · 2D
          </option>
        </select>
      </label>
      <div
        ref={ref}
        className="chart-canvas"
        aria-label="Material diagnostic over time"
      />
    </div>
  );
}
