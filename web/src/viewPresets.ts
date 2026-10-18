import { defaultAnalysis, type AnalysisPreferences } from "./sources/analysis";
import { metricDefinitions } from "./metrics";
import { palettes } from "./palettes";
import {
  initialOptions,
  type Source,
  type ViewOptions,
  type DiagnosticMetric,
} from "./types";
import {
  initialGrid,
  validGridResolution,
  type GridSettings,
} from "./sources/grid";
import type { FieldPreferences } from "./FieldView";
import { sanitizeMetrics, defaultMetrics } from "./metrics";
export interface ColorPreset {
  id: string;
  label: string;
  field: string;
  quantity: "field" | "vorticity" | "divergence";
  palette: string;
  normalization: ViewOptions["normalization"];
  mapping: ViewOptions["mapping"];
  colorPeriod?: number;
}
export const colorPresets: ColorPreset[] = [
  {
    id: "uid-cyclic",
    label: "UIDs · full-range colors",
    field: "UIDs",
    quantity: "field",
    palette: "twilight",
    normalization: "cyclic",
    mapping: "magnitude",
    colorPeriod: 0,
  },
  {
    id: "density",
    label: "Density · linear contrast",
    field: "densities",
    quantity: "field",
    palette: "coolwarm",
    normalization: "linear",
    mapping: "magnitude",
  },
  {
    id: "pressure",
    label: "Pressure · symmetric log",
    field: "pressures",
    quantity: "field",
    palette: "coolwarm",
    normalization: "symlog",
    mapping: "magnitude",
  },
  {
    id: "speed",
    label: "Velocity · sequential",
    field: "velocities",
    quantity: "field",
    palette: "viridis",
    normalization: "linear",
    mapping: "magnitude",
  },
  {
    id: "speed-log",
    label: "Velocity · logarithmic",
    field: "velocities",
    quantity: "field",
    palette: "magma",
    normalization: "log",
    mapping: "magnitude",
  },
  {
    id: "vorticity",
    label: "Vorticity · signed",
    field: "velocities",
    quantity: "vorticity",
    palette: "coolwarm",
    normalization: "linear",
    mapping: "magnitude",
  },
  {
    id: "divergence",
    label: "Divergence · signed log",
    field: "velocities",
    quantity: "divergence",
    palette: "coolwarm",
    normalization: "symlog",
    mapping: "magnitude",
  },
  {
    id: "thermal",
    label: "Specific internal energy",
    field: "internalEnergies",
    quantity: "field",
    palette: "inferno",
    normalization: "linear",
    mapping: "magnitude",
  },
];
export interface ViewLink {
  demo?: string;
  preset?: string;
  time?: number;
  frame?: number;
  field?: string;
  options: Partial<ViewOptions>;
  view: Omit<Partial<FieldPreferences>, "settings"> & {
    settings?: Partial<GridSettings>;
  };
  metrics?: DiagnosticMetric[];
  theme?: "dark" | "light";
  chart?: string;
  analysisView?: "histogram" | "spectrum" | "off";
  analysis?: AnalysisPreferences;
}
const number = (
  p: URLSearchParams,
  key: string,
  min = -Infinity,
  max = Infinity,
) => {
  const raw = p.get(key);
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
export function parseViewLink(search: string): ViewLink {
  const p = new URLSearchParams(search),
    out: ViewLink = { options: {}, view: {} };
  if (["histogram", "spectrum", "off"].includes(p.get("analysisView") ?? ""))
    out.analysisView = p.get("analysisView") as ViewLink["analysisView"];
  out.demo = p.get("demo") ?? undefined;
  out.preset = p.get("preset") ?? undefined;
  out.time = number(p, "time");
  const frame = number(p, "frame", 0);
  if (frame != null && Number.isInteger(frame)) out.frame = frame;
  const color = colorPresets.find((value) => value.id === p.get("colorPreset"));
  if (color) {
    out.field = color.field;
    out.options = {
      palette: color.palette,
      normalization: color.normalization,
      mapping: color.mapping,
      range: "frame",
      ...(color.colorPeriod != null ? { colorPeriod: color.colorPeriod } : {}),
    };
    out.view.settings = { quantity: color.quantity };
    if (color.quantity !== "field") out.view.mode = "grid";
  }
  out.field = p.get("quantity") ?? out.field;
  const one = (key: string, allowed: readonly string[]) => {
    const v = p.get(key);
    return v != null && allowed.includes(v) ? v : undefined;
  };
  const palette = one("palette", Object.keys(palettes));
  if (palette) out.options.palette = palette;
  const normalization = one("scale", ["linear", "log", "symlog", "cyclic"]);
  if (normalization)
    out.options.normalization = normalization as ViewOptions["normalization"];
  const colorPeriod = number(p, "period", 0, 1e9);
  if (colorPeriod != null && Number.isInteger(colorPeriod))
    out.options.colorPeriod = colorPeriod;
  const mapping = one("component", ["magnitude", "x", "y", "z"]);
  if (mapping) out.options.mapping = mapping as ViewOptions["mapping"];
  const display = one("display", ["particles", "grid", "both"]);
  if (display) out.view.mode = display as FieldPreferences["mode"];
  for (const [key, name] of [
    ["wrap", "wrapPeriodic"],
    ["physical", "physical"],
    ["boundaries", "boundaries"],
    ["ghosts", "ghosts"],
    ["referenceGrid", "grid"],
  ] as const)
    if (p.has(key) && ["0", "1"].includes(p.get(key)!))
      out.options[name] = p.get(key) === "1";
  const clipAxis = number(p, "clipAxis", -1, 2),
    clip = number(p, "clip", 0, 1);
  if (clipAxis != null && Number.isInteger(clipAxis))
    out.options.clipAxis = clipAxis;
  if (clip != null) out.options.clip = clip;
  const size = number(p, "size", 0.25, 2.5);
  if (size != null) out.options.size = size;
  if (p.get("range") === "frame") out.options.range = "frame";
  const min = number(p, "min"),
    max = number(p, "max");
  if (min != null && max != null && max > min) {
    out.options.min = min;
    out.options.max = max;
    out.options.range = "fixed";
  }
  const settings: Partial<GridSettings> = { ...out.view.settings };
  let changed = false;
  for (const [key, values] of [
    ["resolution", [128, 256, 512]],
    ["coverage", []],
  ] as const) {
    const n = number(p, key);
    if (
      n != null &&
      (key === "resolution" ? validGridResolution(n) : n >= 0.05 && n <= 0.95)
    ) {
      if (key === "resolution") settings.resolution = n;
      else settings.minCoverage = n;
      changed = true;
    }
  }
  const kernel = one("kernel", ["wendland2", "wendland4"]),
    backend = one("backend", ["auto", "cpu", "webgpu"]);
  if (kernel) {
    settings.kernel = kernel as GridSettings["kernel"];
    changed = true;
  }
  if (backend) {
    settings.backend = backend as GridSettings["backend"];
    changed = true;
  }
  if (out.field === "vorticity" || out.field === "divergence") {
    settings.quantity = out.field;
    out.field = "velocities";
    out.view.mode ??= "grid";
    out.options.palette ??= "coolwarm";
    changed = true;
  } else if (p.has("quantity")) {
    settings.quantity = "field";
    changed = true;
  }
  if (changed || Object.keys(settings).length) out.view.settings = settings;
  const seeds = number(p, "streamSeeds", 2, 16);
  if (seeds != null && Number.isInteger(seeds)) out.view.seeds = seeds;
  const seedMode = one("seedMode", ["regular", "picked"]);
  if (seedMode) out.view.seedMode = seedMode as "regular" | "picked";
  const sx = number(p, "seedX"),
    sy = number(p, "seedY");
  if (sx != null && sy != null) out.view.seed = [sx, sy];
  else if (out.view.seedMode === "picked") out.view.seedMode = "regular";
  out.chart = one("chart", [
    ...Object.keys(metricDefinitions),
    "pressure",
    "material",
    "histogram",
    "spectrum",
  ]);
  if (
    ["bins", "fft", "window", "mask", "axis", "slice"].some((key) => p.has(key))
  ) {
    out.analysis = { ...defaultAnalysis };
    const bins = number(p, "bins", 8, 256);
    if (bins != null && Number.isInteger(bins)) out.analysis.bins = bins;
    out.analysis.kind =
      (one("fft", ["fft1", "fft2"]) as "fft1" | "fft2") ?? "fft2";
    out.analysis.window =
      (one("window", ["hann", "none"]) as "hann" | "none") ?? "hann";
    out.analysis.mask =
      (one("mask", ["strict", "zero"]) as "strict" | "zero") ?? "zero";
    out.analysis.axis = (one("axis", ["x", "y"]) as "x" | "y") ?? "x";
    out.analysis.slice = number(p, "slice", 0, 1) ?? 0.5;
  }
  if (p.has("streams")) out.view.flow = p.get("streams") === "1";
  if (["0", "1"].includes(p.get("licAnimate") ?? ""))
    out.view.licAnimated = p.get("licAnimate") === "1";
  const licSpeed = number(p, "licSpeed", 1, 20);
  if (licSpeed != null) out.view.licSpeed = licSpeed;
  if (p.has("lic")) out.view.lic = undefined;
  if (p.get("lic") === "1")
    out.view.lic = {
      steps: Number.isInteger(number(p, "licSteps", 4, 32))
        ? number(p, "licSteps", 4, 32)!
        : 16,
      seed: Number.isInteger(number(p, "noiseSeed", 0, 65535))
        ? number(p, "noiseSeed", 0, 65535)!
        : 1,
      contrast: number(p, "contrast", 0.5, 4) ?? 1.8,
    };
  if (p.has("metrics"))
    out.metrics = sanitizeMetrics(p.get("metrics")!.split(","));
  const theme = one("theme", ["dark", "light"]);
  if (theme) out.theme = theme as "dark" | "light";
  return out;
}
export function sourcePreset(source: Source, name?: string) {
  const key = name ?? source.id + source.name,
    khh = /khh|kelvin/i.test(key),
    slosh = /slosh/i.test(key),
    tgv = /tgv|taylor/i.test(key) && source.format !== "Analytical demo",
    wake = /wake|obstacle/i.test(key),
    random = /random|decay/i.test(key);
  const color = colorPresets.find(
    (p) =>
      p.id ===
      (khh
        ? "density"
        : slosh
          ? "pressure"
          : tgv || wake || random
            ? "vorticity"
            : "speed"),
  )!;
  const time = khh
    ? 2.6
    : slosh
      ? 2
      : tgv || wake || random
        ? (source.times.at(-1) ?? 0)
        : 0;
  const index = source.times.reduce(
    (best, t, i) =>
      Math.abs(t - time) < Math.abs(source.times[best] - time) ? i : best,
    0,
  );
  const available = source.fields.some((f) => f.name === color.field),
    field = available
      ? color.field
      : (source.fields.find((f) => f.name === "velocities")?.name ??
        source.fields[0]?.name ??
        "kinds");
  return {
    index,
    field,
    options: {
      palette: color.palette,
      normalization: color.normalization,
      mapping: "magnitude" as const,
      range: "frame" as const,
      clipAxis: -1,
    },
    view: {
      mode: khh || slosh || tgv || wake || random ? "grid" : "particles",
      flow: false,
      settings: {
        ...initialGrid,
        quantity: available ? color.quantity : "field",
      },
      seeds: 8,
      seedMode: "regular",
    } as FieldPreferences,
    metrics: defaultMetrics(!!source.internalEnergyAvailable),
  };
}
export function buildViewURL(
  base: string,
  source: Source,
  index: number,
  field: string,
  options: ViewOptions,
  view: FieldPreferences,
  metrics: DiagnosticMetric[],
  theme: string,
  chart?: string,
  analysis?: AnalysisPreferences,
  analysisView?: "histogram" | "spectrum" | null,
) {
  const url = new URL(base);
  url.search = "";
  const p = url.searchParams;
  if (source.id.startsWith("demo-")) p.set("demo", source.id);
  p.set("time", String(source.times[index]));
  p.set(
    "quantity",
    view.mode !== "particles" &&
      view.settings.quantity &&
      view.settings.quantity !== "field"
      ? view.settings.quantity
      : field,
  );
  p.set("component", options.mapping);
  p.set("palette", options.palette);
  p.set("scale", options.normalization);
  if (options.normalization === "cyclic")
    p.set("period", String(options.colorPeriod));
  p.set("display", view.mode);
  p.set("resolution", String(view.settings.resolution));
  p.set("kernel", view.settings.kernel);
  p.set("coverage", String(view.settings.minCoverage));
  p.set("backend", view.settings.backend ?? "auto");
  p.set("range", options.range);
  p.set("streamSeeds", String(view.seeds));
  p.set("seedMode", view.seedMode);
  if (view.seed) {
    p.set("seedX", String(view.seed[0]));
    p.set("seedY", String(view.seed[1]));
  }
  if (view.licAnimated !== undefined)
    p.set("licAnimate", view.licAnimated ? "1" : "0");
  if (view.licSpeed !== undefined) p.set("licSpeed", String(view.licSpeed));
  if (chart) p.set("chart", chart);
  if (analysisView !== undefined) p.set("analysisView", analysisView ?? "off");
  if (analysis)
    for (const [key, value] of Object.entries({
      bins: analysis.bins,
      fft: analysis.kind,
      window: analysis.window,
      mask: analysis.mask,
      axis: analysis.axis,
      slice: analysis.slice,
    }))
      p.set(key, String(value));
  p.set("streams", view.flow ? "1" : "0");
  p.set("lic", view.lic ? "1" : "0");
  if (view.lic) {
    p.set("licSteps", String(view.lic.steps));
    p.set("noiseSeed", String(view.lic.seed));
    p.set("contrast", String(view.lic.contrast));
  }
  for (const [key, value] of Object.entries({
    wrap: +options.wrapPeriodic,
    size: options.size,
    physical: +options.physical,
    boundaries: +options.boundaries,
    ghosts: +options.ghosts,
    referenceGrid: +options.grid,
    theme,
    metrics: metrics.join(","),
  }))
    p.set(key, String(value));
  if (options.range === "fixed") {
    p.set("min", String(options.min));
    p.set("max", String(options.max));
  }
  return url.href;
}
