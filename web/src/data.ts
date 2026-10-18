import type { DiagnosticMetric } from "./types";
import type { Diagnostic, Frame, Mapping, NumericArray } from "./types";

export function decodeFrame(buffer: ArrayBuffer, allowPartial = false): Frame {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== 0x31525057)
    throw new Error("Invalid WPR1 frame signature.");
  const size = view.getUint32(4, true);
  if (size > buffer.byteLength - 8) throw new Error("Truncated frame header.");
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, size)),
  );
  if (header.version !== 1)
    throw new Error("Unsupported frame protocol version.");
  const base = 8 + Math.ceil(size / 8) * 8;
  const arrays: Frame["arrays"] = {};
  for (const [name, raw] of Object.entries(header.arrays)) {
    const spec = raw as {
      dtype: string;
      shape: number[];
      offset: number;
      bytes: number;
    };
    const width = spec.dtype === "<i8" ? 8 : 4;
    const length = spec.shape.reduce((a, b) => a * b, 1);
    const offset = base + spec.offset;
    if (
      !["<f4", "<i4", "<i8"].includes(spec.dtype) ||
      !spec.shape.length ||
      spec.shape.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      !Number.isSafeInteger(offset) ||
      offset < base ||
      offset % width ||
      length * width !== spec.bytes ||
      offset + spec.bytes > buffer.byteLength
    )
      throw new Error(`Invalid array descriptor: ${name}`);
    const data: NumericArray =
      spec.dtype === "<f4"
        ? new Float32Array(buffer, offset, length)
        : spec.dtype === "<i4"
          ? new Int32Array(buffer, offset, length)
          : new BigInt64Array(buffer, offset, length);
    arrays[name] = { data, shape: spec.shape };
  }
  const p = arrays.positions;
  if (
    !allowPartial &&
    (!p || p.shape.length !== 2 || ![1, 2, 3].includes(p.shape[1]))
  )
    throw new Error("Frame is missing N×1, N×2 or N×3 positions.");
  return {
    physicalBounds: header.physicalBounds,
    domain: header.domain,
    index: header.index,
    time: header.time,
    arrays,
    bytes: buffer.byteLength,
  };
}

export function scalarValues(
  frame: Frame,
  field: string,
  mapping: Mapping,
): Float32Array {
  const a = frame.arrays[field];
  if (!a) throw new Error(`Field ${field} is missing from this frame.`);
  const n = frame.arrays.positions.shape[0],
    components = a.shape[1] ?? 1;
  if (a.shape[0] !== n)
    throw new Error("Field length differs from particle count.");
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (components === 1) out[i] = Number(a.data[i]);
    else if (mapping === "magnitude") {
      let sum = 0;
      for (let j = 0; j < components; j++)
        sum += Number(a.data[i * components + j]) ** 2;
      out[i] = Math.sqrt(sum);
    } else {
      const c = { x: 0, y: 1, z: 2 }[mapping];
      out[i] = c < components ? Number(a.data[i * components + c]) : NaN;
    }
  }
  return out;
}

export function scalarRange(
  values: Float32Array,
  kinds: NumericArray | undefined,
  log = false,
): [number, number] | null {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (
      (kinds && Number(kinds[i]) !== 0) ||
      !Number.isFinite(v) ||
      (log && v <= 0)
    )
      continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (lo === Infinity) return null;
  if (lo === hi) {
    const e = Math.max(Math.abs(lo) * 0.01, 1e-6);
    return log
      ? [Math.max(lo * 0.99, Number.MIN_VALUE), hi * 1.01]
      : [lo - e, hi + e];
  }
  return [lo, hi];
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(e.error ?? "Request failed.");
  }
  return r.json();
}
export const formatNumber = (v: number, digits = 3) =>
  Number.isFinite(v)
    ? Math.abs(v) !== 0 && (Math.abs(v) < 0.001 || Math.abs(v) >= 1e5)
      ? v.toExponential(2)
      : Number(v.toPrecision(digits)).toLocaleString("en-US", {
          maximumFractionDigits: 6,
        })
    : "—";
export const fieldLabel = (s: string) =>
  ({
    velocities: "Velocity",
    densities: "Density",
    pressures: "Pressure",
    internalEnergies: "Specific internal energy",
    masses: "Mass",
    supports: "Kernel support",
    kinds: "Particle kind",
    UIDs: "Particle UID",
    materials: "Material",
  })[s] ?? s.replace(/_/g, " ");

export function diagnosticSeries(
  times: number[],
  rows: Diagnostic[],
  metric: DiagnosticMetric,
): (number | null)[] {
  const samples = new Map(rows.map((row) => [row.index, row[metric]]));
  return times.map((_, i) => samples.get(i) ?? null);
}
