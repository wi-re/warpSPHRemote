import { useEffect, useRef, useState, type ReactNode } from "react";
import { CompanionClient, type Simulation } from "./companion";
import { loadPlotly } from "./Chart";
import { formatNumber } from "./data";
import {
  flattenMeasurement,
  metricLabel,
  measurementCSV,
  sampleSummary,
  type Measurement,
} from "./runMeasurements";
export function RunReport({
  client,
  run,
  onClose,
  onTime,
  runAgainAction,
}: {
  client: CompanionClient;
  run: Simulation;
  onClose: () => void;
  onTime?: (t: number) => void;
  runAgainAction?: ReactNode;
}) {
  const [rows, setRows] = useState<Measurement[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [metric, setMetric] = useState("stepMs"),
    [axis, setAxis] = useState("elapsedSeconds"),
    [storage, setStorage] = useState<any>(),
    [config, setConfig] = useState<unknown>();
  const plot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const a = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    let cursor = 0,
      kept: Measurement[] = [];
    async function load() {
      try {
        while (!a.signal.aborted) {
          const page = await client.measurements(run.id, cursor, a.signal);
          cursor = page.next;
          if (page.samples.length) {
            kept = [...kept, ...page.samples].slice(-50000);
            setRows(kept);
          }
          finished = ["completed", "failed", "stopped"].includes(
            page.status ?? run.status,
          );
          if (!page.more) break;
        }
        if (!a.signal.aborted) {
          setLoading(false);
          if (!finished) timer = setTimeout(load, 2000);
        }
      } catch (e) {
        if (!a.signal.aborted) {
          setError(String(e));
          setLoading(false);
        }
      }
    }
    void load();
    void client
      .runStorage(run.id, a.signal)
      .then(setStorage)
      .catch(() => {});
    return () => {
      a.abort();
      clearTimeout(timer);
    };
  }, [client, run.id]);
  const keys = [
    ...new Set(rows.flatMap((r) => Object.keys(flattenMeasurement(r)))),
  ].filter(
    (k) =>
      ![
        "step",
        "simulationTime",
        "elapsedSeconds",
        "resourceSampledAt",
      ].includes(k),
  );
  const chosen = keys.includes(metric) ? metric : keys[0],
    summary = chosen ? sampleSummary(rows, chosen) : null;
  useEffect(() => {
    const element = plot.current!;
    let cancelled = false,
      P: any;
    void loadPlotly().then((p) => {
      if (cancelled) return;
      P = p;
      const physical = rows.some(
        (r) => r.physical && Object.hasOwn(r.physical, chosen),
      );
      const series = rows.filter((r) =>
        physical
          ? !!r.physical
          : !r.physical || !!r.performance || !!r.resources,
      );
      const maps = series.map(flattenMeasurement);
      return P.react(
        element,
        [
          {
            x: maps.map((m) =>
              axis === "simulationTime" ? m.simulationTime : m.elapsedSeconds,
            ),
            customdata: series.map((r) => r.time),
            y: maps.map((m, i) => m[chosen] ?? null),
            mode: "lines+markers",
            type: "scatter",
            connectgaps: false,
            marker: { size: 3 },
            line: { color: "#83dfc5" },
          },
        ],
        {
          paper_bgcolor: "#18232c",
          plot_bgcolor: "#18232c",
          font: { color: "#c3d2dc" },
          margin: { l: 85, r: 25, t: 20, b: 55 },
          xaxis: {
            title: {
              text:
                axis === "simulationTime"
                  ? "Simulation time"
                  : "Elapsed wall time [s]",
            },
          },
          yaxis: {
            title: { text: metricLabel(chosen ?? "Quantity") },
            automargin: true,
            tickformat: ".4~s",
            rangemode: "tozero",
          },
          uirevision: run.id + chosen + axis,
        },
        { responsive: true, displaylogo: false },
      ).then(() => {
        (element as any).removeAllListeners?.("plotly_click");
        (element as any).on?.("plotly_click", (e: any) => {
          const t = e.points?.[0]?.customdata;
          if (Number.isFinite(t)) onTime?.(t);
        });
      });
    });
    return () => {
      cancelled = true;
      if (P) P.purge(element);
    };
  }, [rows, chosen, axis, run.id]);
  async function download() {
    setError("");
    try {
      let all: Measurement[] = [],
        after = 0;
      while (true) {
        const page = await client.measurements(run.id, after);
        all.push(...page.samples);
        after = page.next;
        if (!page.more) break;
      }
      const url = URL.createObjectURL(
          new Blob([measurementCSV(all)], { type: "text/csv" }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = `${run.id}-measurements.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="run-report inspector-section">
      <div className="section-heading">
        <h3>{run.name} · retained run diagnostics</h3>
        {runAgainAction}
        <button className="secondary-button compact" onClick={onClose}>
          Close report
        </button>
      </div>
      <p>
        Run {run.id} · {run.status} ·{" "}
        {new Date(run.startedAt * 1000).toLocaleString()}
      </p>
      <p className="subtle-note">
        {loading
          ? "Loading…"
          : `${rows.length.toLocaleString()} latest retained samples shown (display limit 50,000). CSV includes all retained samples.`}{" "}
        Click a plotted sample to seek its nearest recorded frame when particle
        history exists. Particle recording{" "}
        {run.recording?.enabled ? "enabled" : "disabled"}.{" "}
        {storage?.recordingBytes != null
          ? `Particle files: ${(storage.recordingBytes / 1e6).toFixed(2)} MB.`
          : ""}{" "}
        {storage?.libraryPath && `Library: ${storage.libraryPath}`}
      </p>
      <div className="profile-controls">
        <label>
          Metric
          <select
            value={chosen ?? ""}
            onChange={(e) => setMetric(e.target.value)}
          >
            {keys.map((k) => (
              <option key={k} value={k}>
                {metricLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Horizontal axis
          <select value={axis} onChange={(e) => setAxis(e.target.value)}>
            <option value="elapsedSeconds">Elapsed wall time</option>
            <option value="simulationTime">Simulation time</option>
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={!rows.length}
          onClick={() => void download()}
        >
          Download diagnostics CSV
        </button>
        <button
          className="secondary-button"
          disabled={!run.configurationAvailable}
          onClick={() =>
            void client
              .configurationOfRun(run.id)
              .then(setConfig)
              .catch((e) => setError(String(e)))
          }
        >
          Inspect saved configuration
        </button>
      </div>
      {summary && (
        <p>
          Sample minimum {formatNumber(summary.min, 6)} · median{" "}
          {formatNumber(summary.median, 6)} · p95 {formatNumber(summary.p95, 6)}{" "}
          · sampled maximum {formatNumber(summary.max, 6)} ({summary.count}{" "}
          values). Statistics describe samples, not exact peaks or a
          time-weighted average.
        </p>
      )}
      {!loading && !rows.length && (
        <p>
          No diagnostics were recorded. Enable “Record physical and performance
          diagnostics” when launching; particle recording remains separate.
        </p>
      )}
      <div ref={plot} style={{ width: "100%", height: 340 }} />
      <p className="subtle-note">
        RAM/VRAM values are bytes; durations ending Ms are milliseconds.
        Physical values use solver units. GPU utilization (%), power (W) and
        temperature (°C) are device-wide; process VRAM is PID-attributed.
        Missing counters leave gaps. stepMs is rolling active boundary
        throughput, excluding deliberate holds, not an individual CUDA kernel
        profile.
      </p>
      {storage?.diagnosticProbes &&
        Object.keys(storage.diagnosticProbes).length > 0 && (
          <details>
            <summary>Recorded probe definitions (CSV probe IDs)</summary>
            <pre style={{ maxHeight: 250, overflow: "auto" }}>
              {JSON.stringify(storage.diagnosticProbes, null, 2)}
            </pre>
          </details>
        )}
      {config != null && (
        <details open>
          <summary>Read-only resolved configuration</summary>
          <pre style={{ maxHeight: 350, overflow: "auto" }}>
            {JSON.stringify(config, null, 2)}
          </pre>
        </details>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
