import type { RawFrame } from "./core";
import type { Mapping } from "../types";
import type { FieldQuery, GridData } from "./grid";
export interface AnalysisPreferences {
  bins: number;
  kind: "fft1" | "fft2";
  window: "hann" | "none";
  mask: "strict" | "zero";
  axis: "x" | "y";
  slice: number;
}
export const defaultAnalysis: AnalysisPreferences = {
  bins: 64,
  kind: "fft2",
  window: "hann",
  mask: "zero",
  axis: "x",
  slice: 0.5,
};
export function sanitizeAnalysis(value: unknown): AnalysisPreferences {
  const out = { ...defaultAnalysis },
    v = value as Record<string, unknown>;
  if (!v || typeof v !== "object") return out;
  if (
    typeof v.bins === "number" &&
    Number.isInteger(v.bins) &&
    v.bins >= 8 &&
    v.bins <= 256
  )
    out.bins = v.bins;
  if (v.kind === "fft1" || v.kind === "fft2") out.kind = v.kind;
  if (v.window === "hann" || v.window === "none") out.window = v.window;
  if (v.mask === "strict" || v.mask === "zero") out.mask = v.mask;
  if (v.axis === "x" || v.axis === "y") out.axis = v.axis;
  if (
    typeof v.slice === "number" &&
    Number.isFinite(v.slice) &&
    v.slice >= 0 &&
    v.slice <= 1
  )
    out.slice = v.slice;
  return out;
}
export interface AnalysisQuery {
  index: number;
  field: string;
  mapping: Mapping;
  kind: "histogram" | "fft1" | "fft2";
  bins: number;
  grid?: FieldQuery;
  window: "hann" | "none";
  mask: "strict" | "zero";
  axis: "x" | "y";
  slice: number;
}
export interface Histogram {
  kind: "histogram";
  x: number[];
  y: number[];
  valid: number;
  excluded: number;
  width: number;
}
export interface Spectrum {
  kind: "fft1" | "fft2";
  frequency: number[];
  power: number[];
  image?: Float32Array;
  width: number;
  height: number;
  bounds: number[][];
  valid: number;
  total: number;
  mean: number;
  window: string;
  mask: string;
  totalPower: number;
}
export type AnalysisResult = (Histogram | Spectrum) & {
  index: number;
  time: number;
  field: string;
};
export function scalarSamples(raw: RawFrame, field: string, mapping: Mapping) {
  const array = raw[field];
  if (!array) throw new Error("The mapped quantity was not recorded.");
  if (["UIDs", "kinds", "materials"].includes(field))
    throw new Error("Choose a continuous quantity for statistical analysis.");
  const n = raw.positions.shape[0],
    components = array.shape[1] ?? 1,
    component = { x: 0, y: 1, z: 2 }[mapping as "x" | "y" | "z"],
    out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number(raw.kinds.data[i]) !== 0) continue;
    let value = 0;
    if (components === 1) value = Number(array.data[i]);
    else if (mapping === "magnitude") {
      for (let c = 0; c < components; c++)
        value += Number(array.data[i * components + c]) ** 2;
      value = Math.sqrt(value);
    } else
      value =
        component < components
          ? Number(array.data[i * components + component])
          : NaN;
    out[i] = value;
  }
  return out;
}
export function histogram(values: Float32Array, bins: number): Histogram {
  if (!Number.isInteger(bins) || bins < 8 || bins > 256)
    throw new Error("Choose 8–256 histogram bins.");
  let min = Infinity,
    max = -Infinity,
    valid = 0;
  for (const value of values)
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      valid++;
    }
  if (!valid) throw new Error("No finite mapped samples are available.");
  if (min === max) {
    const eps = Math.max(Math.abs(min) * 0.01, 1e-6);
    min -= eps;
    max += eps;
  }
  const width = (max - min) / bins,
    y = Array(bins).fill(0);
  for (const value of values)
    if (Number.isFinite(value))
      y[Math.min(bins - 1, Math.floor((value - min) / width))]++;
  return {
    kind: "histogram",
    x: y.map((_, i) => min + (i + 0.5) * width),
    y,
    width,
    valid,
    excluded: values.length - valid,
  };
}
const power2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
/** Unnormalized forward radix-2 transform. The spectrum normalization below obeys Parseval. */
export function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length;
  if (imag.length !== n || n < 1 || n & (n - 1))
    throw new Error("FFT arrays must have equal power-of-two lengths.");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const angle = (-2 * Math.PI) / len,
      wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let ur = 1,
        ui = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = start + j,
          b = a + len / 2,
          tr = ur * real[b] - ui * imag[b],
          ti = ur * imag[b] + ui * real[b];
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
        const next = ur * wr - ui * wi;
        ui = ur * wi + ui * wr;
        ur = next;
      }
    }
  }
}
export function spatialSpectrum(
  grid: GridData,
  q: Pick<AnalysisQuery, "kind" | "window" | "mask" | "axis" | "slice">,
): Spectrum {
  if (
    !["fft1", "fft2"].includes(q.kind) ||
    !["hann", "none"].includes(q.window) ||
    !["strict", "zero"].includes(q.mask) ||
    !["x", "y"].includes(q.axis) ||
    !(q.slice >= 0 && q.slice <= 1)
  )
    throw new Error("Invalid spectral analysis settings.");
  const w = grid.width,
    h = grid.height,
    dx = (grid.bounds[1][0] - grid.bounds[0][0]) / w,
    dy = (grid.bounds[1][1] - grid.bounds[0][1]) / h;
  const values =
    q.kind === "fft1"
      ? Float32Array.from(
          { length: q.axis === "x" ? w : h },
          (_, i) =>
            grid.values[
              q.axis === "x"
                ? Math.min(h - 1, Math.round(q.slice * (h - 1))) * w + i
                : i * w + Math.min(w - 1, Math.round(q.slice * (w - 1)))
            ],
        )
      : grid.values;
  let valid = 0,
    sum = 0;
  for (const value of values)
    if (Number.isFinite(value)) {
      valid++;
      sum += value;
    }
  if (!valid) throw new Error("No finite samples for the spatial spectrum.");
  if (q.mask === "strict" && valid !== values.length)
    throw new Error(
      "This grid contains masked samples. Choose the explicitly zero-masked spectrum or a fully covered periodic field.",
    );
  const mean = sum / valid,
    window = (i: number, n: number) =>
      q.window === "none" || n === 1
        ? 1
        : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  if (q.kind === "fft1") {
    const n = values.length,
      np = power2(n),
      re = new Float64Array(np),
      im = new Float64Array(np);
    for (let i = 0; i < n; i++)
      re[i] = Number.isFinite(values[i])
        ? (values[i] - mean) * window(i, n)
        : 0;
    fft(re, im);
    const frequency: number[] = [],
      power: number[] = [];
    for (let k = 0; k <= np / 2; k++) {
      frequency.push(k / (np * (q.axis === "x" ? dx : dy)));
      power.push(
        ((re[k] ** 2 + im[k] ** 2) / (np * n)) *
          (k === 0 || k === np / 2 ? 1 : 2),
      );
    }
    return {
      kind: "fft1",
      frequency,
      power,
      width: np,
      height: 1,
      bounds: grid.bounds,
      valid,
      total: n,
      mean,
      window: q.window,
      mask: q.mask,
      totalPower: power.reduce((s, v) => s + v, 0),
    };
  }
  const wp = power2(w),
    hp = power2(h),
    count = wp * hp,
    re = new Float64Array(count),
    im = new Float64Array(count);
  if (count > 512 * 512)
    throw new Error("Spatial spectra are limited to 512² padded cells.");
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const value = values[y * w + x];
      if (Number.isFinite(value))
        re[y * wp + x] = (value - mean) * window(x, w) * window(y, h);
    }
  for (let y = 0; y < hp; y++)
    fft(re.subarray(y * wp, (y + 1) * wp), im.subarray(y * wp, (y + 1) * wp));
  const cr = new Float64Array(hp),
    ci = new Float64Array(hp);
  for (let x = 0; x < wp; x++) {
    for (let y = 0; y < hp; y++) {
      cr[y] = re[y * wp + x];
      ci[y] = im[y * wp + x];
    }
    fft(cr, ci);
    for (let y = 0; y < hp; y++) {
      re[y * wp + x] = cr[y];
      im[y * wp + x] = ci[y];
    }
  }
  const df = Math.min(1 / (wp * dx), 1 / (hp * dy)),
    binCount = Math.ceil(Math.hypot(1 / (2 * dx), 1 / (2 * dy)) / df) + 1,
    power = Array(binCount).fill(0),
    image = new Float32Array(count);
  let totalPower = 0;
  for (let y = 0; y < hp; y++)
    for (let x = 0; x < wp; x++) {
      const i = y * wp + x,
        value = (re[i] ** 2 + im[i] ** 2) / (count * w * h),
        fx = (x < wp / 2 ? x : x - wp) / (wp * dx),
        fy = (y < hp / 2 ? y : y - hp) / (hp * dy);
      power[Math.min(binCount - 1, Math.floor(Math.hypot(fx, fy) / df))] +=
        value;
      totalPower += value;
      image[((y + hp / 2) % hp) * wp + ((x + wp / 2) % wp)] = value;
    }
  return {
    kind: "fft2",
    frequency: power.map((_, i) => (i + 0.5) * df),
    power,
    image,
    width: wp,
    height: hp,
    bounds: [
      [-1 / (2 * dx), -1 / (2 * dy)],
      [1 / (2 * dx), 1 / (2 * dy)],
    ],
    valid,
    total: w * h,
    mean,
    window: q.window,
    mask: q.mask,
    totalPower,
  };
}
