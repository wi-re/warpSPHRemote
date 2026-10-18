import { useEffect, useRef, useState } from "react";
import { Plus, X, Download } from "lucide-react";
import { loadPlotly, resizeVisiblePlot } from "./Chart";
import {
  newProfile,
  type ProfileSettings,
  type ProfileResult,
} from "./profiles";
import type { Frame, Source } from "./types";
import type { TrajectorySource } from "./sources/client";
interface Props {
  source: Source;
  reader: TrajectorySource;
  frame: Frame | null;
  theme: "dark" | "light";
  onPick: (uid: string | null, index: number) => void;
  onClose: () => void;
}
function storageKey(source: Source) {
  return "warpsph.profiles.v1:" + source.name;
}
export function ProfilePlots(props: Props) {
  const [plots, setPlots] = useState<ProfileSettings[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(storageKey(props.source)) || "null",
      );
      if (
        Array.isArray(saved) &&
        saved.length <= 12 &&
        saved.every(
          (p) =>
            typeof p.id === "string" &&
            (p.field === "positions" ||
              props.source.fields.some((f) => f.name === p.field)) &&
            Array.isArray(p.center) &&
            p.center.length === 3 &&
            p.center.every(Number.isFinite),
        )
      )
        return saved.map((p) => ({ ...newProfile(), ...p }));
    } catch {}
    return [
      newProfile(
        props.source.fields.find((f) => f.name === "densities")?.name ??
          props.source.fields.find(
            (f) => f.name !== "UIDs" && f.name !== "kinds",
          )?.name ??
          "positions",
      ),
    ];
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(props.source), JSON.stringify(plots));
    } catch {}
  }, [plots, props.source.name]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <section
        className="modal profiles-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Profile plots"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="companion-heading">
          <div>
            <h2>Profile plots</h2>
            <p>
              Current frame · t = {props.frame?.time.toPrecision(5) ?? "—"} ·{" "}
              {props.source.name}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close profile plots"
            onClick={props.onClose}
          >
            <X />
          </button>
        </header>
        <p>
          Scatter keeps individual particles. Binned profiles show a weighted
          mean with ±1 standard deviation. Tangential means the signed azimuthal
          component in the xy plane; radius uses every spatial dimension.
        </p>
        <button
          className="secondary-button"
          disabled={plots.length >= 12}
          onClick={() =>
            setPlots((p) => [
              ...p,
              newProfile(
                props.source.fields.find((f) => f.name === "densities")?.name ??
                  props.source.fields.find(
                    (f) => f.name !== "UIDs" && f.name !== "kinds",
                  )?.name ??
                  "positions",
              ),
            ])
          }
        >
          <Plus size={15} /> Add plot
        </button>
        {plots.map((settings, i) => (
          <ProfilePlot
            key={settings.id}
            {...props}
            settings={settings}
            onChange={(value) =>
              setPlots((p) => p.map((a) => (a.id === value.id ? value : a)))
            }
            onRemove={() =>
              setPlots((p) => p.filter((a) => a.id !== settings.id))
            }
            number={i + 1}
          />
        ))}
        {!plots.length && (
          <p>
            Add a plot to compare quantities against position, radius or angle.
          </p>
        )}
      </section>
    </div>
  );
}
function ProfilePlot({
  source,
  reader,
  frame,
  theme,
  onPick,
  settings: s,
  onChange,
  onRemove,
  number,
}: Props & {
  settings: ProfileSettings;
  onChange: (s: ProfileSettings) => void;
  onRemove: () => void;
  number: number;
}) {
  const ref = useRef<HTMLDivElement>(null),
    pick = useRef(onPick);
  pick.current = onPick;
  const [result, setResult] = useState<ProfileResult | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const change = <K extends keyof ProfileSettings>(
    key: K,
    value: ProfileSettings[K],
  ) => onChange({ ...s, [key]: value });
  const [computedTime, setComputedTime] = useState<number | null>(null);
  const newest = useRef({ frame, settings: s });
  newest.current = { frame, settings: s };
  const schedule = useRef<() => void>(() => {});
  useEffect(() => {
    const abort = new AbortController();
    let working = false;
    let job: { frame: Frame; settings: ProfileSettings } | null = null;
    let completed: {
      index: number;
      time: number;
      settings: ProfileSettings;
    } | null = null;
    const worker = new Worker(
      new URL("./profiles.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = (data: { result?: ProfileResult; error?: string }) => {
      if (abort.signal.aborted) return;
      if (job && newest.current.settings === job.settings) {
        setError(data.error || "");
        setResult(data.result ?? null);
        setComputedTime(job.frame.time);
      }
      working = false;
      setBusy(false);
      schedule.current();
    };
    schedule.current = () => {
      const next = newest.current;
      if (
        working ||
        abort.signal.aborted ||
        !next.frame ||
        (completed &&
          completed.index === next.frame.index &&
          completed.time === next.frame.time &&
          completed.settings === next.settings)
      )
        return;
      job = { frame: next.frame, settings: next.settings };
      completed = {
        index: next.frame.index,
        time: next.frame.time,
        settings: next.settings,
      };
      const current = job;
      working = true;
      setBusy(true);
      if (newest.current.settings !== current.settings) setResult(null);
      (async () => {
        const f = current.frame.arrays[current.settings.field]
          ? current.frame
          : await reader.frame(
              current.frame.index,
              current.settings.field,
              abort.signal,
            );
        if (abort.signal.aborted) return;
        if (f.time !== current.frame.time)
          throw new Error("Waiting for a coherent displayed snapshot.");
        let arrays = f.arrays;
        if (
          current.settings.selection === "material" &&
          !arrays[current.settings.materialField]
        ) {
          const material = await reader.frame(
            f.index,
            current.settings.materialField,
            abort.signal,
          );
          if (material.time !== f.time)
            throw new Error("Waiting for a coherent material snapshot.");
          arrays = {
            ...arrays,
            [current.settings.materialField]:
              material.arrays[current.settings.materialField],
          };
        }
        if (abort.signal.aborted) return;
        const names = new Set([
          "positions",
          "kinds",
          "UIDs",
          "masses",
          "densities",
          current.settings.field,
          current.settings.materialField,
        ]);
        worker.postMessage({
          frame: {
            ...f,
            arrays: Object.fromEntries(
              Object.entries(arrays).filter(([name]) => names.has(name)),
            ),
          },
          settings: current.settings,
          domain: f.domain ?? source.domain,
        });
      })().catch((e) => finish({ error: e.message }));
    };
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = () => finish({ error: "Profile computation failed." });
    schedule.current();
    return () => {
      abort.abort();
      worker.terminate();
      schedule.current = () => {};
    };
  }, [reader, source.domain]);
  useEffect(() => {
    setError("");
    setResult(null);
    setComputedTime(null);
    schedule.current();
  }, [s]);
  useEffect(() => {
    schedule.current();
  }, [frame?.index, frame?.time]);
  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (cancelled) return;
      observer = new ResizeObserver(() => resizeVisiblePlot(P, el));
      observer.observe(el);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      loadPlotly().then((P) => P.purge(el));
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadPlotly()
      .then(async (P) => {
        if (cancelled || !ref.current) return;
        const el = ref.current;
        const data = result;
        await P.react(
          el,
          data
            ? [
                {
                  x: data.x,
                  y: data.y,
                  type: "scatter",
                  mode: s.mode === "scatter" ? "markers" : "lines+markers",
                  marker: {
                    size: s.mode === "scatter" ? 3 : 4,
                    color: "#75ddba",
                  },
                  customdata: data.indices.map((index, i) => ({
                    index,
                    uid: data.uid[i],
                  })),
                  error_y:
                    s.mode === "binned"
                      ? {
                          type: "data",
                          array: data.spread,
                          visible: true,
                          color: "#75ddba",
                          thickness: 1,
                        }
                      : undefined,
                  hovertemplate: "%{x:.5g}<br>%{y:.5g}<extra></extra>",
                },
              ]
            : [],
          {
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font: { color: theme === "light" ? "#334957" : "#9eafbc" },
            margin: { l: 65, r: 20, t: 15, b: 50 },
            xaxis: {
              title: {
                text:
                  s.coordinate === "angle" ? "Angle (radians)" : s.coordinate,
              },
              type: s.xlog ? "log" : "linear",
            },
            yaxis: {
              title: {
                text:
                  s.field +
                  (source.fields.find((f) => f.name === s.field)?.components! >
                  1
                    ? " · " + s.component
                    : ""),
              },
              type: s.ylog ? "log" : "linear",
            },
            uirevision: s.id,
          },
          { responsive: true, displaylogo: false },
        );
        if (cancelled) return;
        (el as any).removeAllListeners?.("plotly_click");
        (el as any).on?.("plotly_click", (e: any) => {
          const c = e.points?.[0]?.customdata;
          if (c?.index != null) pick.current(c.uid, c.index);
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [result, theme, s, source]);
  function download() {
    if (!result) return;
    const rows = [
      "coordinate,value,stddev,count,uid,particleIndex",
      ...result.x.map((x, i) =>
        [
          x,
          result.y[i],
          result.spread[i] ?? "",
          result.counts[i] ?? "",
          result.uid[i] ?? "",
          result.indices[i] ?? "",
        ].join(","),
      ),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.join("\n")], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `profile-${s.field}-${frame?.index ?? 0}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <article className="profile-card">
      <div className="section-heading">
        Plot {number}
        <button className="text-button" disabled={!result} onClick={download}>
          <Download size={14} /> CSV
        </button>
        <button
          className="icon-button"
          aria-label={`Remove plot ${number}`}
          onClick={onRemove}
        >
          <X size={16} />
        </button>
      </div>
      <div className="profile-controls">
        <label>
          Quantity
          <select
            value={s.field}
            onChange={(e) => change("field", e.target.value)}
          >
            {[
              {
                name: "positions",
                components: source.dimension,
                dtype: "Float32Array",
              },
              ...source.fields.filter((f) => f.name !== "positions"),
            ]
              .filter((f) => !["UIDs", "kinds"].includes(f.name))
              .map((f) => (
                <option key={f.name}>{f.name}</option>
              ))}
          </select>
        </label>
        <label>
          Horizontal coordinate
          <select
            value={s.coordinate}
            onChange={(e) => change("coordinate", e.target.value as any)}
          >
            {[
              "x",
              ...(source.dimension > 1 ? ["y"] : []),
              ...(source.dimension === 3 ? ["z"] : []),
              "radius",
              ...(source.dimension > 1 ? ["angle"] : []),
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Component
          <select
            value={s.component}
            onChange={(e) => change("component", e.target.value as any)}
          >
            {[
              "magnitude",
              "x",
              ...(source.dimension > 1 ? ["y"] : []),
              ...(source.dimension === 3 ? ["z"] : []),
              "radial",
              ...(source.dimension > 1 ? ["tangential"] : []),
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Plot type
          <select
            value={s.mode}
            onChange={(e) => change("mode", e.target.value as any)}
          >
            <option value="scatter">Particle scatter</option>
            <option value="binned">Binned mean ± stddev</option>
          </select>
        </label>
        {s.mode === "binned" && (
          <>
            <label>
              Bins
              <input
                type="number"
                min={2}
                max={2048}
                value={s.bins}
                onChange={(e) => change("bins", +e.target.value)}
              />
            </label>
            <label>
              Weight
              <select
                value={s.weight}
                onChange={(e) => change("weight", e.target.value as any)}
              >
                {["count", "mass", "volume"].map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <details>
        <summary>Coordinates, selection and scales</summary>
        <div className="profile-controls">
          {Array.from({ length: source.dimension }, (_, c) => (
            <label key={c}>
              Centre {"xyz"[c]}
              <input
                type="number"
                step="any"
                value={s.center[c] ?? 0}
                onChange={(e) =>
                  change(
                    "center",
                    s.center.map((v, j) => (j === c ? +e.target.value : v)),
                  )
                }
              />
            </label>
          ))}
          <label>
            Particles
            <select
              value={s.selection}
              onChange={(e) =>
                onChange({
                  ...s,
                  selection: e.target.value as any,
                  materialField:
                    source.fields.find((f) => /material/i.test(f.name))?.name ??
                    source.fields.find((f) => f.components === 1)?.name ??
                    s.materialField,
                })
              }
            >
              <option value="fluid">Fluid only</option>
              <option value="all">All particles</option>
              <option value="kind">Specific kind</option>
              <option value="material">Specific material</option>
            </select>
          </label>
          {s.selection === "kind" && (
            <label>
              Kind
              <input
                type="number"
                value={s.kind}
                onChange={(e) => change("kind", +e.target.value)}
              />
            </label>
          )}
          {s.selection === "material" && (
            <>
              <label>
                Material field
                <select
                  value={s.materialField}
                  onChange={(e) => change("materialField", e.target.value)}
                >
                  {source.fields
                    .filter((f) => f.components === 1)
                    .map((f) => (
                      <option key={f.name}>{f.name}</option>
                    ))}
                </select>
              </label>
              <label>
                Material ID
                <input
                  type="number"
                  value={s.material}
                  onChange={(e) => change("material", +e.target.value)}
                />
              </label>
            </>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.sector}
              onChange={(e) => change("sector", e.target.checked)}
            />{" "}
            Angular sector (xy plane)
          </label>
          {s.sector && (
            <>
              <label>
                Start angle (radians)
                <input
                  type="number"
                  step="any"
                  value={s.angleMin}
                  onChange={(e) => change("angleMin", +e.target.value)}
                />
              </label>
              <label>
                End angle (radians)
                <input
                  type="number"
                  step="any"
                  value={s.angleMax}
                  onChange={(e) => change("angleMax", +e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Slice axis
            <select
              value={s.sliceAxis}
              onChange={(e) => change("sliceAxis", +e.target.value)}
            >
              <option value={-1}>No slice</option>
              {Array.from({ length: source.dimension }, (_, c) => (
                <option key={c} value={c}>
                  {"xyz"[c]}
                </option>
              ))}
            </select>
          </label>
          {s.sliceAxis >= 0 && (
            <>
              <label>
                Slice minimum
                <input
                  type="number"
                  step="any"
                  value={s.sliceMin}
                  onChange={(e) => change("sliceMin", +e.target.value)}
                />
              </label>
              <label>
                Slice maximum
                <input
                  type="number"
                  step="any"
                  value={s.sliceMax}
                  onChange={(e) => change("sliceMax", +e.target.value)}
                />
              </label>
            </>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.wrap}
              onChange={(e) => change("wrap", e.target.checked)}
            />{" "}
            Wrap positions to domain
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.xlog}
              onChange={(e) => change("xlog", e.target.checked)}
            />{" "}
            Log x
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={s.ylog}
              onChange={(e) => change("ylog", e.target.checked)}
            />{" "}
            Log y
          </label>
        </div>
        <small>
          Centre uses displayed domain coordinates. Radial displacement does not
          apply the minimum-image convention. Zero-radius vector projections and
          nonpositive log values are omitted.
        </small>
      </details>
      <div ref={ref} className="profile-chart" />
      <small role="status">
        {busy
          ? "Computing profile…"
          : error ||
            (result
              ? `t = ${computedTime?.toPrecision(5) ?? "—"} · ${result.accepted.toLocaleString()} accepted · ${result.omitted} invalid/log samples omitted${result.sampled ? " · scatter display sampled to at most 30,000 points" : ""}`
              : "No displayed frame.")}
      </small>
    </article>
  );
}
