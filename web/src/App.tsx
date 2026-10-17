import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  FolderOpen,
  Grid2X2,
  Info,
  Layers,
  LoaderCircle,
  Maximize,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Repeat2,
  Rotate3D,
  Settings2,
  SlidersHorizontal,
  Target,
  X,
} from "lucide-react";
import { ParticleRenderer } from "./renderer";
import { decodeFrame, fieldLabel, formatNumber, request } from "./data";
import { gradient, palettes } from "./palettes";
import { DiagnosticChart } from "./Chart";
import { initialOptions } from "./types";
import type { Diagnostic, Frame, Source, ViewOptions } from "./types";

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`toggle ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span />
    </button>
  );
}
function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
const mergeRows = (old: Diagnostic[], next: Diagnostic[]) =>
  [...new Map([...old, ...next].map((r) => [r.index, r])).values()].sort(
    (a, b) => a.index - b.index,
  );
const friendlyName = (source: Source) =>
  source.name
    .replace(/-pyvista$|-vispy$/, "")
    .replace("marrone31", "Marrone · wall impact")
    .replace(/^tgv$/, "Taylor–Green vortex")
    .replace(/^khh$/, "Kelvin–Helmholtz")
    .replace(/^sod$/, "Sod shock tube");

export default function App() {
  const [sources, setSources] = useState<Source[]>([]),
    [sourceId, setSourceId] = useState("");
  const source = sources.find((s) => s.id === sourceId);
  const [frame, setFrame] = useState<Frame | null>(null),
    [index, setIndex] = useState(0),
    [field, setField] = useState("velocities");
  const [options, setOptions] = useState<ViewOptions>(initialOptions),
    [range, setRange] = useState<[number, number]>([0, 1]),
    [validRange, setValidRange] = useState(true);
  const [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(true),
    [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [engineError, setEngineError] = useState("");
  const [open, setOpen] = useState(false),
    [path, setPath] = useState(""),
    [opening, setOpening] = useState(false),
    [openError, setOpenError] = useState("");
  const [rows, setRows] = useState<Diagnostic[]>([]),
    [diagnosticError, setDiagnosticError] = useState(""),
    [metric, setMetric] = useState<
      "kineticEnergy" | "maxSpeed" | "meanDensity"
    >("kineticEnergy");
  const [selected, setSelected] = useState(-1),
    [renderMs, setRenderMs] = useState(0),
    [fetchMs, setFetchMs] = useState(0),
    [inspector, setInspector] = useState(true),
    [help, setHelp] = useState(false),
    [mobileControls, setMobileControls] = useState(false);
  const [axes, setAxes] = useState([
    [1, 0],
    [0, 1],
    [0, 0],
  ]);
  const host = useRef<HTMLDivElement>(null),
    engine = useRef<ParticleRenderer | null>(null),
    initialFocus = useRef<HTMLInputElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const setOption = <K extends keyof ViewOptions>(
    key: K,
    value: ViewOptions[K],
  ) => setOptions((o) => ({ ...o, [key]: value }));
  const chooseSource = (s: Source) => {
    setPlaying(false);
    setSourceId(s.id);
    setIndex(0);
    setFrame(null);
    setSelected(-1);
    setError("");
    setRows([]);
    setField(
      s.fields.find((f) => f.name === "velocities")?.name ??
        s.fields[0]?.name ??
        "kinds",
    );
    setOptions((o) => ({
      ...o,
      range: "frame",
      clipAxis: -1,
      mapping: "magnitude",
    }));
  };
  useEffect(() => {
    const abort = new AbortController();
    request<Source[]>("/api/sources", { signal: abort.signal })
      .then((list) => {
        setSources(list);
        if (list.length) chooseSource(list[0]);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setError(
            e.message + " Start the local file service to open trajectories.",
          );
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!host.current) return;
    try {
      const e = new ParticleRenderer(host.current);
      engine.current = e;
      e.onPick = setSelected;
      e.onRender = (ms) => {
        setRenderMs(ms);
        setAxes(e.axes());
      };
      return () => {
        e.dispose();
        engine.current = null;
      };
    } catch (e) {
      setEngineError(
        `The GPU renderer could not start: ${e instanceof Error ? e.message : String(e)}. Enable WebGL2 in your browser.`,
      );
    }
  }, []);
  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const t = performance.now();
    fetch(
      `/api/sources/${source.id}/frames/${index}?field=${encodeURIComponent(field)}`,
      { signal: abort.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error);
        return r.arrayBuffer();
      })
      .then((buffer) => {
        if (abort.signal.aborted) return;
        setFrame(decodeFrame(buffer));
        setFetchMs(performance.now() - t);
        setSelected(-1);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setPlaying(false);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [sourceId, index, field]);
  useEffect(() => {
    if (
      !frame ||
      !source ||
      !engine.current ||
      frame.index !== index ||
      !frame.arrays[field]
    )
      return;
    try {
      engine.current.setFrame(frame, source, field, optionsRef.current);
      setRange([...engine.current.range]);
      setValidRange(engine.current.validRange);
      setEngineError("");
    } catch (e) {
      setEngineError(String(e));
    }
  }, [frame, sourceId, field]);
  useEffect(() => {
    if (engine.current) {
      engine.current.setOptions(options);
      setRange([...engine.current.range]);
      setValidRange(engine.current.validRange);
    }
  }, [options]);
  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    setRows([]);
    setDiagnosticError("");
    const load = async () => {
      for (let start = 0; start < source.frames; start += 16) {
        const batch = await request<Diagnostic[]>(
          `/api/sources/${source.id}/diagnostics?start=${start}&count=16`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setRows((old) => mergeRows(old, batch));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    load().catch((e) => {
      if (e.name !== "AbortError") setDiagnosticError(e.message);
    });
    return () => abort.abort();
  }, [sourceId]);
  useEffect(() => {
    if (!frame || !source || rows.some((r) => r.index === frame.index)) return;
    const abort = new AbortController();
    request<Diagnostic[]>(
      `/api/sources/${source.id}/diagnostics?start=${frame.index}&count=1`,
      { signal: abort.signal },
    )
      .then((batch) => {
        if (!abort.signal.aborted) setRows((old) => mergeRows(old, batch));
      })
      .catch((e) => {
        if (e.name !== "AbortError") setDiagnosticError(e.message);
      });
    return () => abort.abort();
  }, [frame, sourceId]);
  useEffect(() => {
    if (!playing || !source || !frame || loading || frame.index !== index)
      return;
    if (index === source.frames - 1) {
      if (loop) {
        const timer = setTimeout(() => setIndex(0), 100);
        return () => clearTimeout(timer);
      }
      setPlaying(false);
      return;
    }
    const delta =
      source.timeKind === "simulation"
        ? (source.times[index + 1] - source.times[index]) * 1000
        : 100;
    const timer = setTimeout(
      () => setIndex(index + 1),
      Math.max(16, delta / speed),
    );
    return () => clearTimeout(timer);
  }, [playing, sourceId, frame, index, loading, speed, loop]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
          (e.target as HTMLElement).tagName,
        ) ||
        open ||
        help
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        if (source) setPlaying((v) => !v);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => Math.min((source?.frames ?? 1) - 1, i + 1));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => Math.max(0, i - 1));
      }
      if (e.key.toLowerCase() === "f") engine.current?.fit();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [source, open, help]);
  useEffect(() => {
    if (open) initialFocus.current?.focus();
    else if (help)
      document.querySelector<HTMLElement>("[role=dialog] button")?.focus();
  }, [open, help]);
  useEffect(() => {
    if (!open && !help) return;
    const previous = document.activeElement as HTMLElement;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setHelp(false);
      }
      if (e.key === "Tab") {
        const dialog = document.querySelector("[role=dialog]");
        const elements = Array.from(
          dialog?.querySelectorAll<HTMLElement>(
            'button,input,select,[tabindex="0"]',
          ) ?? [],
        ).filter((el) => !el.hasAttribute("disabled"));
        if (!elements.length) return;
        const first = elements[0],
          last = elements.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [open, help]);
  const openSource = async (e: React.FormEvent) => {
    e.preventDefault();
    setOpening(true);
    setOpenError("");
    try {
      const next = await request<Source>("/api/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WarpSPH-Client": "trajectory-viewer",
        },
        body: JSON.stringify({ path }),
      });
      setSources((old) => [...old, next]);
      chooseSource(next);
      setOpen(false);
      setPath("");
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };
  const currentField = source?.fields.find((f) => f.name === field),
    isVector = (currentField?.components ?? 1) > 1;
  const current = rows.find((r) => r.index === frame?.index);
  const scalarTitle =
    fieldLabel(field) +
    (isVector
      ? " · " +
        (options.mapping === "magnitude"
          ? "magnitude"
          : options.mapping.toUpperCase())
      : "");
  const seek = (i: number) => {
    setPlaying(false);
    setIndex(i);
  };
  const n = frame?.arrays.positions.shape[0] ?? 0;
  const selectedPosition =
    selected >= 0 && frame
      ? Array.from({ length: source?.dimension ?? 2 }, (_, c) =>
          Number(
            frame.arrays.positions.data[
              selected * (source?.dimension ?? 2) + c
            ],
          ),
        )
      : [];
  const selectedValue =
    selected >= 0 ? engine.current?.values[selected] : undefined;
  const hasMetric = rows.some((r) => r[metric] !== null);
  const fixedError =
    options.range === "fixed" &&
    (!(options.max > options.min) ||
      (options.normalization === "log" && options.min <= 0));

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="warpSPH Remote home">
          <span className="brand-mark">
            <Activity size={23} />
          </span>
          <span>
            warp<span className="brand-sph">SPH</span>
            <span className="brand-remote">Remote</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="header-context">Trajectory studio</span>
        <span className="version">PREVIEW 0.1</span>
        <div className="header-actions">
          <span className="local-status">
            <span />
            Local workspace
          </span>
          <button className="secondary-button" onClick={() => setOpen(true)}>
            <FolderOpen size={15} />
            Open trajectory
          </button>
          <IconButton label="Viewer help" onClick={() => setHelp(true)}>
            <Info size={18} />
          </IconButton>
        </div>
      </header>
      <div className={`workspace ${inspector ? "" : "inspector-hidden"}`}>
        <aside className={`sidebar ${mobileControls ? "show-controls" : ""}`}>
          <section className="library-section">
            <div className="section-heading">
              <span>TRAJECTORIES</span>
              <button
                className="small-icon"
                aria-label="Add trajectory"
                title="Add trajectory"
                onClick={() => setOpen(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="source-list">
              {sources.map((s) => (
                <button
                  className={`source-card ${s.id === sourceId ? "selected" : ""}`}
                  key={s.id}
                  onClick={() => chooseSource(s)}
                  title={s.name}
                >
                  <span className="source-icon">
                    {s.dimension === 3 ? (
                      <Box size={17} />
                    ) : (
                      <Layers size={17} />
                    )}
                  </span>
                  <span className="source-card-text">
                    <strong>{friendlyName(s)}</strong>
                    <small>
                      {s.dimension}D · {s.frames} frames
                      {s.format === "Analytical demo" ? " · demo" : ""}
                    </small>
                  </span>
                  {s.id === sourceId && <span className="selected-dot" />}
                </button>
              ))}
              {!sources.length && (
                <p className="muted">
                  Connect to the local file service to get started.
                </p>
              )}
            </div>
          </section>
          <button
            className="mobile-settings secondary-button"
            aria-expanded={mobileControls}
            onClick={() => setMobileControls((v) => !v)}
          >
            <SlidersHorizontal size={14} />
            {mobileControls ? "Hide view settings" : "View settings"}
          </button>
          <section className="control-section">
            <div className="section-heading">
              <span>COLOR BY</span>
              <SlidersHorizontal size={14} />
            </div>
            <label className="control-label" htmlFor="field">
              Particle quantity
            </label>
            <div className="select-wrap">
              <select
                id="field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                disabled={!source}
              >
                {source?.fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {fieldLabel(f.name)}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
            {isVector && (
              <div
                className="segmented mapping"
                role="group"
                aria-label="Vector component"
              >
                {(
                  [
                    "magnitude",
                    "x",
                    "y",
                    ...(currentField!.components >= 3 ? ["z"] : []),
                  ] as ViewOptions["mapping"][]
                ).map((m) => (
                  <button
                    key={m}
                    className={options.mapping === m ? "selected" : ""}
                    onClick={() => setOption("mapping", m)}
                  >
                    {m === "magnitude" ? "Magnitude" : m.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            <label className="control-label" htmlFor="palette">
              Color palette
            </label>
            <div className="palette-select">
              <div
                className="palette-strip"
                style={{ background: gradient(options.palette) }}
              />
              <div className="select-wrap">
                <select
                  id="palette"
                  value={options.palette}
                  onChange={(e) => setOption("palette", e.target.value)}
                >
                  {Object.entries(palettes).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.label} · {p.category}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
            </div>
            <label className="control-label" htmlFor="normalization">
              Normalization
            </label>
            <div className="select-wrap">
              <select
                id="normalization"
                value={options.normalization}
                onChange={(e) =>
                  setOption(
                    "normalization",
                    e.target.value as ViewOptions["normalization"],
                  )
                }
              >
                <option value="linear">Linear</option>
                <option value="log">Logarithmic</option>
                <option value="symlog">Symmetric log · threshold 1</option>
              </select>
              <ChevronDown size={13} />
            </div>
            <div className="label-row">
              <span>Color range</span>
              <button
                className="text-button"
                onClick={() =>
                  setOptions((o) => ({
                    ...o,
                    range: o.range === "frame" ? "fixed" : "frame",
                    min: range[0],
                    max: range[1],
                  }))
                }
              >
                {options.range === "frame" ? "Auto · per frame" : "Fixed range"}
              </button>
            </div>
            <div className="range-inputs">
              <label>
                <span>MIN</span>
                <input
                  aria-label="Minimum color value"
                  type="number"
                  step="any"
                  disabled={options.range === "frame"}
                  value={
                    options.range === "frame"
                      ? Number(range[0].toPrecision(5))
                      : options.min
                  }
                  onChange={(e) => setOption("min", Number(e.target.value))}
                />
              </label>
              <span>—</span>
              <label>
                <span>MAX</span>
                <input
                  aria-label="Maximum color value"
                  type="number"
                  step="any"
                  disabled={options.range === "frame"}
                  value={
                    options.range === "frame"
                      ? Number(range[1].toPrecision(5))
                      : options.max
                  }
                  onChange={(e) => setOption("max", Number(e.target.value))}
                />
              </label>
            </div>
            {fixedError && (
              <p className="inline-error">
                Maximum must exceed minimum; logarithmic bounds must be
                positive. Showing automatic range.
              </p>
            )}
          </section>
          <section className="control-section">
            <div className="section-heading">
              <span>APPEARANCE</span>
              <Settings2 size={14} />
            </div>
            <div className="label-row">
              <label htmlFor="size">Particle scale</label>
              <span className="mono">{options.size.toFixed(2)}×</span>
            </div>
            <input
              id="size"
              className="slider"
              type="range"
              min="0.25"
              max="2.5"
              step="0.05"
              value={options.size}
              onChange={(e) => setOption("size", +e.target.value)}
            />
            <div className="toggle-row">
              <span>Physical particle size</span>
              <Toggle
                label="Physical particle size"
                value={options.physical}
                onChange={(v) => setOption("physical", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Boundary particles</span>
              <Toggle
                label="Boundary particles"
                value={options.boundaries}
                onChange={(v) => setOption("boundaries", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Ghost particles</span>
              <Toggle
                label="Ghost particles"
                value={options.ghosts}
                onChange={(v) => setOption("ghosts", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Reference grid</span>
              <Toggle
                label="Reference grid"
                value={options.grid}
                onChange={(v) => setOption("grid", v)}
              />
            </div>
            <div className="label-row background-row">
              <span>Background</span>
              <div className="segmented">
                <button
                  className={options.background === "dark" ? "selected" : ""}
                  onClick={() => setOption("background", "dark")}
                >
                  Dark
                </button>
                <button
                  className={options.background === "light" ? "selected" : ""}
                  onClick={() => setOption("background", "light")}
                >
                  Light
                </button>
              </div>
            </div>
          </section>
          <div className="sidebar-foot">
            <span className="tiny-dot" />
            Browser-rendered · WebGL2
          </div>
        </aside>
        <main className="main-panel">
          <div className="viewport-heading">
            <div>
              <div className="eyebrow">
                {source?.format === "Analytical demo"
                  ? "ANALYTICAL FIELD"
                  : "RECORDED TRAJECTORY"}
              </div>
              <h1>
                {source ? friendlyName(source) : "Your simulation, in view."}
              </h1>
            </div>
            <div className="viewport-heading-actions">
              <span className="dimension-badge">
                {source?.dimension ?? "—"}D PARTICLES
              </span>
              <IconButton
                label="Toggle inspector"
                active={inspector}
                onClick={() => setInspector((v) => !v)}
              >
                <Settings2 size={16} />
              </IconButton>
            </div>
          </div>
          <section
            className={`viewport ${options.background === "light" ? "light" : ""}`}
            aria-label="Particle visualization"
          >
            <div className="scene-host" ref={host} />
            <div className="scene-title">
              <span className="scene-title-dot" />
              {scalarTitle}
              {source && (
                <span className="scene-time">
                  {source.timeKind === "simulation" ? "t = " : "frame "}
                  {formatNumber(frame?.time ?? 0, 5)}
                </span>
              )}
            </div>
            <div className="scene-tools">
              <IconButton
                label="Fit current frame (F)"
                onClick={() => engine.current?.fit()}
              >
                <Maximize size={17} />
              </IconButton>
              <IconButton
                label="Export scene as PNG"
                onClick={() => engine.current?.exportImage()}
                disabled={!frame}
              >
                <ArrowDownToLine size={17} />
              </IconButton>
            </div>
            {loading && (
              <div className="loading-badge">
                <LoaderCircle size={13} className="spin" />
                Reading frame
              </div>
            )}
            {(error || engineError) && (
              <div className="scene-message error" role="alert">
                <Info size={22} />
                <strong>Unable to display this frame</strong>
                <p>{engineError || error}</p>
                <button
                  className="secondary-button"
                  onClick={() => setOpen(true)}
                >
                  Open another trajectory
                </button>
              </div>
            )}
            {!frame && !loading && !error && !engineError && (
              <div className="scene-message">
                <Layers size={30} />
                <strong>Open a trajectory to begin</strong>
                <p>Explore recorded SPH data with a GPU-rendered scene.</p>
                <button
                  className="primary-button"
                  onClick={() => setOpen(true)}
                >
                  Open trajectory
                </button>
              </div>
            )}
            {frame && (
              <>
                <div className="scene-caption">
                  <span>{n.toLocaleString()} particles</span>
                  <span>
                    {source?.dimension === 3 ? (
                      <Rotate3D size={12} />
                    ) : (
                      <MousePointer2 size={12} />
                    )}{" "}
                    {source?.dimension === 3 ? "Drag to orbit" : "Drag to pan"}{" "}
                    · Scroll to zoom
                  </span>
                </div>
                <div className="color-legend">
                  <div className="legend-title">{scalarTitle}</div>
                  <div
                    className="legend-gradient"
                    style={{ background: gradient(options.palette) }}
                  />
                  <div className="legend-values">
                    <span>{formatNumber(range[0], 4)}</span>
                    <span>{formatNumber(range[1], 4)}</span>
                  </div>
                  {!validRange && (
                    <span className="invalid-note">
                      No valid fluid values · shown gray
                    </span>
                  )}
                </div>
                <svg
                  className="orientation"
                  viewBox="0 0 54 54"
                  aria-label="Camera orientation"
                >
                  {axes.slice(0, source?.dimension ?? 2).map(([x, y], c) => (
                    <g
                      key={c}
                      stroke={["#d88d82", "#74bf9c", "#8baee4"][c]}
                      fill={["#d88d82", "#74bf9c", "#8baee4"][c]}
                    >
                      <line x1="27" y1="27" x2={27 + x * 17} y2={27 - y * 17} />
                      <text
                        x={27 + x * 24}
                        y={30 - y * 24}
                        textAnchor="middle"
                        stroke="none"
                        fontSize="8"
                      >
                        {"XYZ"[c]}
                      </text>
                    </g>
                  ))}
                </svg>
              </>
            )}
          </section>
          <section className="transport" aria-label="Trajectory playback">
            <div className="transport-buttons">
              <IconButton
                label="First frame"
                onClick={() => seek(0)}
                disabled={!source || index === 0}
              >
                <ChevronsLeft size={17} />
              </IconButton>
              <IconButton
                label="Previous frame"
                onClick={() => seek(Math.max(0, index - 1))}
                disabled={!source || index === 0}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <button
                className="play-button"
                aria-label={playing ? "Pause playback" : "Play trajectory"}
                disabled={!source || source.frames < 2 || !!error}
                onClick={() => {
                  if (source && index === source.frames - 1 && !loop)
                    setIndex(0);
                  setPlaying((v) => !v);
                }}
              >
                {playing ? (
                  <Pause size={17} fill="currentColor" />
                ) : (
                  <Play size={17} fill="currentColor" />
                )}
              </button>
              <IconButton
                label="Next frame"
                onClick={() =>
                  seek(Math.min((source?.frames ?? 1) - 1, index + 1))
                }
                disabled={!source || index >= source.frames - 1}
              >
                <ChevronRight size={18} />
              </IconButton>
              <IconButton
                label="Last frame"
                onClick={() => seek((source?.frames ?? 1) - 1)}
                disabled={!source || index >= source.frames - 1}
              >
                <ChevronsRight size={17} />
              </IconButton>
            </div>
            <div className="scrubber">
              <div className="scrubber-info">
                <span>
                  FRAME <strong>{String(index + 1).padStart(3, "0")}</strong>
                  <span className="muted">
                    {" "}
                    / {String(source?.frames ?? 0).padStart(3, "0")}
                  </span>
                </span>
                <span>
                  {source?.timeKind === "simulation"
                    ? "SIMULATION TIME"
                    : "FRAME INDEX"}{" "}
                  <strong>{formatNumber(source?.times[index] ?? 0, 5)}</strong>
                </span>
              </div>
              <input
                className="slider timeline"
                aria-label="Trajectory frame"
                type="range"
                min="0"
                max={Math.max(0, (source?.frames ?? 1) - 1)}
                value={index}
                disabled={!source}
                onChange={(e) => seek(+e.target.value)}
              />
            </div>
            <select
              className="speed-select"
              aria-label="Playback speed"
              value={speed}
              onChange={(e) => setSpeed(+e.target.value)}
            >
              {[0.25, 0.5, 1, 2, 4].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
            <IconButton
              label="Loop playback"
              active={loop}
              onClick={() => setLoop((v) => !v)}
            >
              <Repeat2 size={17} />
            </IconButton>
          </section>
          <section className="diagnostics">
            <div className="diagnostics-heading">
              <div className="section-heading">
                <Activity size={14} />
                <span>DIAGNOSTICS</span>
              </div>
              <div
                className="diagnostic-tabs"
                role="group"
                aria-label="Diagnostic quantity"
              >
                {(
                  [
                    ["kineticEnergy", "Kinetic energy"],
                    ["maxSpeed", "Max. speed"],
                    ["meanDensity", "Mean density"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={metric === id ? "selected" : ""}
                    onClick={() => setMetric(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="diagnostic-progress">
                {rows.length < (source?.frames ?? 0)
                  ? `${rows.length} / ${source?.frames} frames`
                  : "Fluid particles only"}
              </span>
            </div>
            {source && (
              <DiagnosticChart
                rows={rows}
                source={source}
                metric={metric}
                index={index}
              />
            )}
            <div className="chart-note">
              {diagnosticError ? (
                <span className="inline-error">{diagnosticError}</span>
              ) : rows.length > 0 && !hasMetric ? (
                "This quantity is unavailable in this trajectory. Missing values are not replaced with zeros."
              ) : source?.format === "Analytical demo" ? (
                "Analytical field sampled on a fixed lattice; this is not an advected solver trajectory."
              ) : (
                "Computed from recorded numerical arrays. Playback slows when reading takes longer than the requested interval."
              )}
            </div>
          </section>
        </main>
        {inspector && (
          <aside className="inspector">
            <div className="inspector-title">
              <span>INSPECTOR</span>
              <Target size={15} />
            </div>
            <section className="inspector-section">
              <div className="section-heading">CURRENT FRAME</div>
              <div className="metric-large">
                {n.toLocaleString()}
                <span>particles</span>
              </div>
              <dl className="properties">
                <dt>Fluid particles</dt>
                <dd>{current?.particles.toLocaleString() ?? "—"}</dd>
                <dt>Dimension</dt>
                <dd>{source?.dimension ?? "—"}D</dd>
                <dt>Simulation time</dt>
                <dd>
                  {source?.timeKind === "simulation"
                    ? formatNumber(frame?.time ?? 0, 5)
                    : "Not recorded"}
                </dd>
                <dt>Frame size</dt>
                <dd>{frame ? `${(frame.bytes / 1e6).toFixed(2)} MB` : "—"}</dd>
              </dl>
            </section>
            <section className="inspector-section">
              <div className="section-heading">FLUID DIAGNOSTICS</div>
              <div className="stat-card">
                <span>Kinetic energy</span>
                <strong>
                  {current?.kineticEnergy != null
                    ? formatNumber(current.kineticEnergy, 5)
                    : "—"}
                </strong>
                <span className="stat-unit">½ ∑ mᵢ |vᵢ|²</span>
              </div>
              <dl className="properties">
                <dt>Maximum speed</dt>
                <dd>
                  {current?.maxSpeed != null
                    ? formatNumber(current.maxSpeed, 4)
                    : "—"}
                </dd>
                <dt>Mean density</dt>
                <dd>
                  {current?.meanDensity != null
                    ? formatNumber(current.meanDensity, 5)
                    : "—"}
                </dd>
              </dl>
            </section>
            {source?.dimension === 3 && (
              <section className="inspector-section">
                <div className="section-heading">CLIPPING</div>
                <div className="select-wrap">
                  <select
                    aria-label="Clipping axis"
                    value={options.clipAxis}
                    onChange={(e) => setOption("clipAxis", +e.target.value)}
                  >
                    <option value="-1">Show full volume</option>
                    <option value="0">Clip along X</option>
                    <option value="1">Clip along Y</option>
                    <option value="2">Clip along Z</option>
                  </select>
                  <ChevronDown size={13} />
                </div>
                {options.clipAxis >= 0 && (
                  <>
                    <div className="label-row">
                      <span>Visible extent</span>
                      <span>{Math.round(options.clip * 100)}%</span>
                    </div>
                    <input
                      className="slider"
                      aria-label="Clipping position"
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={options.clip}
                      onChange={(e) => setOption("clip", +e.target.value)}
                    />
                  </>
                )}
              </section>
            )}
            <section className="inspector-section">
              <div className="section-heading">PARTICLE PROBE</div>
              {selected >= 0 && frame ? (
                <>
                  <div className="probe-title">
                    <span>
                      UID{" "}
                      {frame.arrays.UIDs
                        ? String(frame.arrays.UIDs.data[selected])
                        : "not recorded"}
                    </span>
                    <button
                      className="small-icon"
                      aria-label="Clear particle selection"
                      onClick={() => {
                        setSelected(-1);
                        engine.current?.select(-1);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <dl className="properties">
                    <dt>Array index</dt>
                    <dd>{selected}</dd>
                    {selectedPosition.map((v, c) => (
                      <span className="property-pair" key={c}>
                        <dt>{"XYZ"[c]}</dt>
                        <dd>{formatNumber(v, 5)}</dd>
                      </span>
                    ))}
                    <dt>{fieldLabel(field)}</dt>
                    <dd>
                      {selectedValue === undefined
                        ? "—"
                        : formatNumber(selectedValue, 5)}
                    </dd>
                    <dt>Kind</dt>
                    <dd>{String(frame.arrays.kinds.data[selected])}</dd>
                  </dl>
                </>
              ) : (
                <div className="probe-empty">
                  <MousePointer2 size={20} />
                  <p>
                    Click a particle in the scene to inspect its recorded
                    values.
                  </p>
                </div>
              )}
              {source?.identity === "unavailable" && (
                <p className="subtle-note">
                  UIDs were not recorded. Selection applies to this frame only.
                </p>
              )}
            </section>
            <div className="inspector-bottom">
              <Eye size={14} />
              <span>
                Viewing recorded data
                <br />
                <strong>Simulator disconnected</strong>
              </span>
            </div>
          </aside>
        )}
      </div>
      <footer className="status-bar">
        <span>
          <span className="tiny-dot" />
          {source?.format ?? "No source"}
          <span className="status-separator">/</span>
          {loading
            ? "Reading snapshot"
            : playing
              ? "Playing trajectory"
              : "Ready to inspect"}
        </span>
        <span>
          Read + transfer {fetchMs.toFixed(1)} ms
          <span className="status-separator">/</span>CPU render submission{" "}
          {renderMs.toFixed(1)} ms<span className="status-separator">/</span>
          <button onClick={() => setHelp(true)}>
            Keyboard shortcuts <kbd>?</kbd>
          </button>
        </span>
      </footer>
      {open && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="open-title"
          >
            <div className="modal-heading">
              <span className="modal-icon">
                <FolderOpen size={22} />
              </span>
              <IconButton
                label="Close open dialog"
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <h2 id="open-title">Open a trajectory</h2>
            <p>
              Read an existing recording directly from this computer. Files stay
              local and are opened read-only.
            </p>
            <form onSubmit={openSource}>
              <label className="control-label" htmlFor="path">
                Local file or directory path
              </label>
              <input
                ref={initialFocus}
                id="path"
                className="path-input"
                placeholder="/path/to/run/trajectory.h5"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required
              />
              <div className="format-hints">
                <span>HDF5 trajectories</span>
                <span>NPZ snapshot sequences</span>
              </div>
              {openError && (
                <div className="form-error" role="alert">
                  {openError}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={opening || !path.trim()}
                >
                  {opening ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <FolderOpen size={15} />
                  )}{" "}
                  {opening ? "Opening…" : "Open trajectory"}
                </button>
              </div>
            </form>
            <div className="modal-footnote">
              <Info size={14} />
              <span>
                Use an absolute path or ~/… . A run folder containing
                trajectory.h5 also works. The local file service must be
                running.
              </span>
            </div>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modal-heading">
              <span className="modal-icon">
                <Info size={22} />
              </span>
              <IconButton label="Close help" onClick={() => setHelp(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <h2 id="help-title">A closer look at your simulation.</h2>
            <p>
              Recorded arrays are rendered in your browser. Changing the camera
              or colors never calls a simulator.
            </p>
            <dl className="shortcut-list">
              <dt>Play / pause</dt>
              <dd>
                <kbd>Space</kbd>
              </dd>
              <dt>Previous / next frame</dt>
              <dd>
                <kbd>←</kbd> <kbd>→</kbd>
              </dd>
              <dt>Fit current frame</dt>
              <dd>
                <kbd>F</kbd>
              </dd>
              <dt>Pan · 2D</dt>
              <dd>Left drag</dd>
              <dt>Orbit · 3D</dt>
              <dd>Left drag</dd>
              <dt>Pan · 3D</dt>
              <dd>Right drag</dd>
              <dt>Zoom</dt>
              <dd>Scroll</dd>
              <dt>Inspect particle</dt>
              <dd>Click</dd>
            </dl>
            <p className="subtle-note">
              Logarithmic views show nonpositive or invalid values in gray.
              Boundaries and ghosts are passive gray. Color limits use fluid
              particles. Units follow the recording; no unit conversions are
              applied. The reference box shows the first frame's particle
              bounds.
            </p>
            <button className="primary-button" onClick={() => setHelp(false)}>
              <Check size={15} />
              Got it
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
