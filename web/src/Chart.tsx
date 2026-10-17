import type { DiagnosticMetric } from "./types";
import { useEffect, useRef } from "react";
import {
  clickedFrame,
  type PressureProbe,
  type ProbeSample,
} from "./sources/probes";
import type { Diagnostic, Source } from "./types";
import { diagnosticSeries } from "./data";
let plotlyPromise: Promise<any> | undefined;
export const loadPlotly = () =>
  (plotlyPromise ??= import("plotly.js-basic-dist-min").then((m) => m.default));
/** Plotly debounces resize internally; a tab may unmount before that promise settles. */
export function resizeVisiblePlot(P: any, element: HTMLElement) {
  if (
    !element.isConnected ||
    element.clientWidth === 0 ||
    element.clientHeight === 0
  )
    return;
  void P.Plots.resize(element).catch(() => {
    /* A hidden/unmounted plot no longer needs resizing. */
  });
}
export function DiagnosticChart({
  rows,
  source,
  metric,
  index,
  theme = "dark",
}: {
  rows: Diagnostic[];
  source: Source;
  metric: DiagnosticMetric;
  index: number;
  theme?: "dark" | "light";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current!;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (cancelled) return;
      observer = new ResizeObserver(() => {
        if (!cancelled) resizeVisiblePlot(P, element);
      });
      observer.observe(element);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      loadPlotly().then((P) => P.purge(element));
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then((P) => {
      if (cancelled || !ref.current) return;
      const times = source.live ? rows.map((r) => r.time) : source.times,
        series = source.live
          ? rows.map((r) => r[metric] ?? null)
          : diagnosticSeries(times, rows, metric),
        current = source.live
          ? rows.at(-1)
          : rows.find((r) => r.index === index),
        t = source.live ? current?.time : times[index];
      P.react(
        ref.current,
        [
          {
            x: times,
            y: series,
            connectgaps: false,
            type: "scatter",
            mode: "lines",
            line: {
              color: theme === "light" ? "#187c5c" : "#75ddba",
              width: 2,
            },
            fill: "tozeroy",
            fillcolor: "rgba(117,221,186,.045)",
            hovertemplate: "%{x:.4g}<br>%{y:.5g}<extra></extra>",
          },
          {
            x: current?.[metric] != null ? [t] : [],
            y: current?.[metric] != null ? [current[metric]] : [],
            type: "scatter",
            mode: "markers",
            marker: {
              color: theme === "light" ? "#187c5c" : "#b6ffe1",
              size: 7,
            },
            hoverinfo: "skip",
          },
        ],
        {
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: {
            family: "Inter, system-ui, sans-serif",
            color: theme === "light" ? "#526776" : "#8394a5",
            size: 10,
          },
          margin: { l: 61, r: 20, t: 10, b: 28 },
          showlegend: false,
          xaxis: {
            title: {
              text:
                source.timeKind === "simulation"
                  ? "Simulation time"
                  : "Frame index",
              font: { size: 10 },
            },
            gridcolor: theme === "light" ? "#cbd7df" : "#26313b",
            zeroline: false,
            range: [
              times[0],
              times.at(-1) === times[0] ? times[0] + 1 : times.at(-1),
            ],
            fixedrange: false,
          },
          yaxis: {
            gridcolor: theme === "light" ? "#cbd7df" : "#26313b",
            zeroline: false,
            tickformat: ".3~g",
            autorange: true,
          },
          shapes: [
            {
              type: "line",
              xref: "x",
              yref: "paper",
              x0: t,
              x1: t,
              y0: 0,
              y1: 1,
              line: { color: "#8b9bac", width: 1, dash: "dot" },
            },
          ],
          uirevision: source.id + metric,
        },
        { responsive: true, displayModeBar: false, scrollZoom: false },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [rows, source, metric, index, theme]);
  return (
    <div
      className="chart-canvas"
      ref={ref}
      aria-label={`${metric} over ${source.timeKind === "simulation" ? "simulation time" : "frame index"}`}
    />
  );
}

export function PressureChart({
  rows,
  probes,
  source,
  index,
  onSeek,
  theme = "dark",
}: {
  rows: ProbeSample[];
  probes: PressureProbe[];
  source: Source;
  index: number;
  theme?: "dark" | "light";
  onSeek: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    seek = useRef(onSeek);
  seek.current = onSeek;
  useEffect(() => {
    const element = ref.current!;
    let cancelled = false,
      observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (cancelled) return;
      observer = new ResizeObserver(() => {
        if (!cancelled) resizeVisiblePlot(P, element);
      });
      observer.observe(element);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      loadPlotly().then((P) => P.purge(element));
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(async (P) => {
      if (cancelled || !ref.current) return;
      const element = ref.current,
        byIndex = new Map(rows.map((r) => [r.index, r])),
        times = source.live ? rows.map((r) => r.time) : source.times;
      await P.react(
        element,
        probes.map((p, c) => ({
          x: times,
          y: source.live
            ? rows.map((r) => r.values[p.id] ?? null)
            : times.map((_, i) => byIndex.get(i)?.values[p.id] ?? null),
          customdata: source.live ? [] : times.map((_, i) => i),
          name: p.name,
          mode: "lines+markers",
          type: "scatter",
          connectgaps: false,
          line: {
            color: (theme === "light"
              ? ["#187c5c", "#956014", "#4865ba", "#a53e68"]
              : ["#75ddba", "#e6b873", "#91aafa", "#e78aab"])[c],
            width: 2,
          },
          marker: { size: 4 },
          hovertemplate:
            "%{x:.5g}<br>pressure %{y:.5g}<extra>%{fullData.name}</extra>",
        })),
        {
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: {
            family: "Inter,system-ui,sans-serif",
            color: theme === "light" ? "#526776" : "#8394a5",
            size: 10,
          },
          margin: { l: 61, r: 20, t: 10, b: 28 },
          showlegend: probes.length > 1,
          legend: { orientation: "h", y: 1.15 },
          xaxis: {
            title: {
              text:
                source.timeKind === "simulation"
                  ? "Simulation time"
                  : "Frame index",
              font: { size: 10 },
            },
            gridcolor: theme === "light" ? "#cbd7df" : "#26313b",
            zeroline: false,
            range: [times[0], times.at(-1) || 1],
          },
          yaxis: {
            gridcolor: theme === "light" ? "#cbd7df" : "#26313b",
            zeroline: false,
            tickformat: ".3~g",
          },
          shapes: [
            {
              type: "line",
              xref: "x",
              yref: "paper",
              x0: source.live ? rows.at(-1)?.time : source.times[index],
              x1: source.live ? rows.at(-1)?.time : source.times[index],
              y0: 0,
              y1: 1,
              line: { color: "#8b9bac", width: 1, dash: "dot" },
            },
          ],
          uirevision: source.id + probes.map((p) => p.id).join(","),
        },
        { responsive: true, displayModeBar: false },
      );
      if (cancelled) return;
      const graph = element as any;
      graph.removeAllListeners("plotly_click");
      graph.on("plotly_click", (event: any) => {
        if (source.live) return;
        const frame = clickedFrame(event, source.frames);
        if (frame !== null) seek.current(frame);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows, probes, source, index, theme]);
  return (
    <div
      className="chart-canvas"
      ref={ref}
      aria-label="Pressure probe histories; click a sample to seek the recorded frame"
    />
  );
}
