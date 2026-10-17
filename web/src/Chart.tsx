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
export function DiagnosticChart({
  rows,
  source,
  metric,
  index,
}: {
  rows: Diagnostic[];
  source: Source;
  metric: DiagnosticMetric;
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current!;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (cancelled) return;
      observer = new ResizeObserver(() => P.Plots.resize(element));
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
      const series = diagnosticSeries(source.times, rows, metric),
        current = rows.find((r) => r.index === index),
        t = source.times[index];
      P.react(
        ref.current,
        [
          {
            x: source.times,
            y: series,
            connectgaps: false,
            type: "scatter",
            mode: "lines",
            line: { color: "#75ddba", width: 2 },
            fill: "tozeroy",
            fillcolor: "rgba(117,221,186,.045)",
            hovertemplate: "%{x:.4g}<br>%{y:.5g}<extra></extra>",
          },
          {
            x: current?.[metric] != null ? [t] : [],
            y: current?.[metric] != null ? [current[metric]] : [],
            type: "scatter",
            mode: "markers",
            marker: { color: "#b6ffe1", size: 7 },
            hoverinfo: "skip",
          },
        ],
        {
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: {
            family: "Inter, system-ui, sans-serif",
            color: "#8394a5",
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
            gridcolor: "#26313b",
            zeroline: false,
            range: [
              source.times[0],
              source.times.at(-1) === source.times[0]
                ? source.times[0] + 1
                : source.times.at(-1),
            ],
            fixedrange: false,
          },
          yaxis: {
            gridcolor: "#26313b",
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
  }, [rows, source, metric, index]);
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
}: {
  rows: ProbeSample[];
  probes: PressureProbe[];
  source: Source;
  index: number;
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
      observer = new ResizeObserver(() => P.Plots.resize(element));
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
        byIndex = new Map(rows.map((r) => [r.index, r]));
      await P.react(
        element,
        probes.map((p, c) => ({
          x: source.times,
          y: source.times.map((_, i) => byIndex.get(i)?.values[p.id] ?? null),
          customdata: source.times.map((_, i) => i),
          name: p.name,
          mode: "lines+markers",
          type: "scatter",
          connectgaps: false,
          line: {
            color: ["#75ddba", "#e6b873", "#91aafa", "#e78aab"][c],
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
            color: "#8394a5",
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
            gridcolor: "#26313b",
            zeroline: false,
            range: [source.times[0], source.times.at(-1) || 1],
          },
          yaxis: { gridcolor: "#26313b", zeroline: false, tickformat: ".3~g" },
          shapes: [
            {
              type: "line",
              xref: "x",
              yref: "paper",
              x0: source.times[index],
              x1: source.times[index],
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
        const frame = clickedFrame(event, source.frames);
        if (frame !== null) seek.current(frame);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows, probes, source, index]);
  return (
    <div
      className="chart-canvas"
      ref={ref}
      aria-label="Pressure probe histories; click a sample to seek the recorded frame"
    />
  );
}
