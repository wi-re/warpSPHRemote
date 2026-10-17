import type { AnalysisPreferences } from "./sources/analysis";
import { useEffect, useRef, useState } from "react";
import { loadPlotly, resizeVisiblePlot } from "./Chart";
import type { TrajectorySource } from "./sources/client";
import type {
  AnalysisQuery,
  AnalysisResult,
  Spectrum,
} from "./sources/analysis";
import type { FieldQuery } from "./sources/grid";
import type { Mapping } from "./types";
import { fieldLabel } from "./data";
import { paletteBytes } from "./palettes";
function SpectrumImage({ result }: { result: Spectrum }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    [hover, setHover] = useState("");
  useEffect(() => {
    if (!result.image || !canvas.current) return;
    const { width: w, height: h, image } = result,
      context = canvas.current.getContext("2d")!;
    canvas.current.width = w;
    canvas.current.height = h;
    const pixels = context.createImageData(w, h),
      palette = paletteBytes("magma");
    let max = 0;
    for (const value of image) max = Math.max(max, value);
    const log = Math.log10(Math.max(max, 1e-30));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j =
            Math.round(
              Math.max(
                0,
                Math.min(
                  1,
                  (Math.log10(Math.max(image[i], 1e-30)) - log + 8) / 8,
                ),
              ) * 255,
            ) * 4;
        pixels.data.set(
          [palette[j], palette[j + 1], palette[j + 2], 255],
          ((h - 1 - y) * w + x) * 4,
        );
      }
    context.putImageData(pixels, 0, 0);
  }, [result]);
  return (
    <div className="spectrum-image">
      <canvas
        ref={canvas}
        aria-label="Centered 2D spatial Fourier power"
        onMouseMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect(),
            x = Math.max(
              0,
              Math.min(
                result.width - 1,
                Math.floor(((e.clientX - b.left) / b.width) * result.width),
              ),
            ),
            y = Math.max(
              0,
              Math.min(
                result.height - 1,
                result.height -
                  1 -
                  Math.floor(((e.clientY - b.top) / b.height) * result.height),
              ),
            ),
            fx =
              result.bounds[0][0] +
              (x / result.width) * (result.bounds[1][0] - result.bounds[0][0]),
            fy =
              result.bounds[0][1] +
              (y / result.height) * (result.bounds[1][1] - result.bounds[0][1]);
          setHover(
            `fₓ ${fx.toPrecision(3)} · fᵧ ${fy.toPrecision(3)} · P ${result.image![y * result.width + x].toExponential(2)}`,
          );
        }}
      />
      <small>{hover || "2D power · log color · DC at center"}</small>
      <small>Frequency [cycles / length]</small>
    </div>
  );
}
export function QuantityAnalysis({
  reader,
  index,
  field,
  mapping,
  grid,
  gridVisible,
  mode,
  theme,
  playing,
  initial,
  onSettings,
}: {
  reader: TrajectorySource;
  index: number;
  field: string;
  mapping: Mapping;
  grid: FieldQuery;
  gridVisible: boolean;
  mode: "histogram" | "spectrum";
  theme: "dark" | "light";
  playing: boolean;
  initial: AnalysisPreferences;
  onSettings: (value: AnalysisPreferences) => void;
}) {
  const [bins, setBins] = useState(initial.bins),
    [kind, setKind] = useState<"fft1" | "fft2">(initial.kind),
    [window, setWindow] = useState<"hann" | "none">(initial.window),
    [mask, setMask] = useState<"zero" | "strict">(initial.mask),
    [axis, setAxis] = useState<"x" | "y">(initial.axis),
    [slice, setSlice] = useState(initial.slice),
    [result, setResult] = useState<AnalysisResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(
    () => onSettings({ bins, kind, window, mask, axis, slice }),
    [bins, kind, window, mask, axis, slice],
  );
  const plot = useRef<HTMLDivElement>(null);
  const query: AnalysisQuery = {
      index,
      field,
      mapping,
      kind: mode === "histogram" ? "histogram" : kind,
      bins,
      grid:
        mode === "spectrum" || gridVisible
          ? { ...grid, streams: null, lic: undefined }
          : undefined,
      window,
      mask,
      axis,
      slice,
    },
    key = JSON.stringify(query);
  useEffect(() => {
    if (playing) {
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      reader
        .analyze(query, abort.signal)
        .then(setResult)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [reader, key, playing]);
  useEffect(() => {
    const el = plot.current!;
    let stopped = false,
      observer: ResizeObserver | undefined;
    loadPlotly().then((P) => {
      if (stopped) return;
      observer = new ResizeObserver(() => {
        if (!stopped) resizeVisiblePlot(P, el);
      });
      observer.observe(el);
    });
    return () => {
      stopped = true;
      observer?.disconnect();
      loadPlotly().then((P) => P.purge(el));
    };
  }, []);
  useEffect(() => {
    if (!result) return;
    let stopped = false;
    loadPlotly().then((P) => {
      if (stopped || !plot.current) return;
      const histogram = result.kind === "histogram",
        x = histogram ? result.x : result.frequency,
        y = histogram ? result.y : result.power,
        light = theme === "light";
      P.react(
        plot.current,
        [
          {
            type: histogram ? "bar" : "scatter",
            mode: "lines",
            x,
            y,
            width: histogram ? result.width : undefined,
            marker: { color: light ? "#187c5c" : "#75ddba" },
            line: { color: light ? "#187c5c" : "#75ddba" },
            hovertemplate: "%{x:.5g}<br>%{y:.5g}<extra></extra>",
          },
        ],
        {
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { size: 10, color: light ? "#526776" : "#8394a5" },
          margin: { l: 55, r: 12, t: 10, b: 36 },
          showlegend: false,
          xaxis: {
            title: {
              text: histogram
                ? fieldLabel(result.field)
                : "Spatial frequency [cycles / length]",
            },
            type: histogram ? "linear" : "log",
            gridcolor: light ? "#cbd7df" : "#26313b",
            zeroline: false,
          },
          yaxis: {
            title: {
              text: histogram ? "Sample count" : "Scalar mean-square power",
            },
            type: histogram ? "linear" : "log",
            gridcolor: light ? "#cbd7df" : "#26313b",
            zeroline: false,
          },
          uirevision: result.field + result.kind,
        },
        { displayModeBar: false, responsive: true },
      );
    });
    return () => {
      stopped = true;
    };
  }, [result, theme]);
  return (
    <div className="quantity-analysis">
      <section
        className="analysis-tools"
        aria-label="Quantity analysis settings"
      >
        {mode === "histogram" ? (
          <>
            <label>
              Histogram bins
              <select
                aria-label="Histogram bins"
                value={bins}
                onChange={(e) => setBins(+e.target.value)}
              >
                {![8, 16, 32, 64, 128, 256].includes(bins) && (
                  <option value={bins}>{bins} (custom)</option>
                )}
                {[8, 16, 32, 64, 128, 256].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <p>
              {gridVisible ? "Covered grid cells" : "Fluid particles"} · finite
              mapped values only
            </p>
          </>
        ) : (
          <>
            <label>
              Spectrum
              <select
                aria-label="Spectrum type"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="fft2">2D FFT + radial shells</option>
                <option value="fft1">1D spatial line FFT</option>
              </select>
            </label>
            <label>
              Window
              <select
                aria-label="Spectral window"
                value={window}
                onChange={(e) => setWindow(e.target.value as typeof window)}
              >
                <option value="hann">Hann</option>
                <option value="none">None · periodic fields</option>
              </select>
            </label>
            <label>
              Missing samples
              <select
                aria-label="Spectrum mask policy"
                value={mask}
                onChange={(e) => setMask(e.target.value as typeof mask)}
              >
                <option value="zero">Zero after mean subtraction</option>
                <option value="strict">Require complete coverage</option>
              </select>
            </label>
            {kind === "fft1" && (
              <>
                <label>
                  Line direction
                  <select
                    aria-label="FFT line direction"
                    value={axis}
                    onChange={(e) => setAxis(e.target.value as typeof axis)}
                  >
                    <option value="x">X</option>
                    <option value="y">Y</option>
                  </select>
                </label>
                <label>
                  Line position
                  <input
                    aria-label="FFT line position"
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value={slice}
                    onChange={(e) => setSlice(+e.target.value)}
                  />
                </label>
              </>
            )}
          </>
        )}
        {playing && <p>Pause playback to update analysis.</p>}
        {busy && <p role="status">Computing mapped quantity…</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="analysis-provenance">
            {result.kind === "histogram"
              ? "Histogram"
              : result.kind === "fft1"
                ? "1D spatial FFT"
                : "2D FFT"}{" "}
            · {fieldLabel(result.field)} · frame {result.index + 1} · t=
            {result.time.toPrecision(5)}
            <br />
            {result.valid.toLocaleString()} valid{" "}
            {result.kind === "histogram"
              ? `· ${result.excluded} excluded`
              : `/ ${result.total} · mean removed · ${result.window} window · ${result.mask === "zero" ? "masked samples set to zero" : "complete coverage"}`}
            <br />
            {result.kind !== "histogram" &&
              `ΣP = ${result.totalPower.toPrecision(5)}`}
          </p>
        )}
      </section>
      {result?.kind === "fft2" && <SpectrumImage result={result} />}
      <div
        className="chart-canvas"
        ref={plot}
        aria-label={
          mode === "histogram"
            ? "Mapped quantity histogram"
            : "Mapped quantity spatial power spectrum"
        }
      />
    </div>
  );
}
