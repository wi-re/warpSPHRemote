import type { Domain } from "../spatial";
import type { Diagnostic, Frame, NumericArray, Source } from "../types";
export type RawNumeric =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;
export interface RawArray {
  data: RawNumeric;
  shape: number[];
}
export type RawFrame = Record<string, RawArray>;
export const baseFields = [
  "positions",
  "kinds",
  "UIDs",
  "masses",
  "supports",
  "densities",
];
export const canonical = (name: string) =>
  ({
    uids: "UIDs",
    position: "positions",
    velocity: "velocities",
    density: "densities",
    pressure: "pressures",
  })[name] ?? name;
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });
export function validateRaw(frame: RawFrame): RawFrame {
  const p = frame.positions;
  if (!p || p.shape.length !== 2 || ![2, 3].includes(p.shape[1]) || !p.shape[0])
    throw new Error("Positions must be a nonempty N×2 or N×3 array.");
  const n = p.shape[0];
  for (const v of p.data)
    if (!Number.isFinite(Number(v)))
      throw new Error("Frame contains nonfinite positions.");
  for (const [name, a] of Object.entries(frame)) {
    if (
      a.shape[0] !== n ||
      a.shape.length > 2 ||
      a.shape.reduce((x, y) => x * y, 1) !== a.data.length
    )
      throw new Error(`Field ${name} does not match this frame's particles.`);
  }
  if (!frame.kinds) frame.kinds = { data: new Int32Array(n), shape: [n] };
  return frame;
}
export abstract class RawSource {
  name = "";
  format = "";
  times: number[] = [];
  domain?: Domain;
  timeKind: Source["timeKind"] = "simulation";
  constructor(public id: string) {}
  abstract read(index: number, field?: string): RawFrame | Promise<RawFrame>;
  async metadata(): Promise<Source> {
    const f = validateRaw(await this.read(0)),
      p = f.positions,
      dim = p.shape[1] as 2 | 3;
    if (this.domain && this.domain.min.length !== dim)
      throw new Error("Domain dimension does not match particle positions.");
    if (
      !this.times.length ||
      this.times.some((t) => !Number.isFinite(t)) ||
      this.times.some((t, i) => i > 0 && t < this.times[i - 1])
    )
      throw new Error("Recording times must be finite and nondecreasing.");
    const lo = Array(dim).fill(Infinity),
      hi = Array(dim).fill(-Infinity);
    for (let i = 0; i < p.shape[0]; i++)
      for (let c = 0; c < dim; c++) {
        const v = Number(p.data[i * dim + c]);
        lo[c] = Math.min(lo[c], v);
        hi[c] = Math.max(hi[c], v);
      }
    return {
      id: this.id,
      name: this.name,
      format: this.format,
      frames: this.times.length,
      times: this.times,
      timeKind: this.timeKind,
      dimension: dim,
      bounds: [lo, hi],
      domain: this.domain,
      identity: f.UIDs ? "UIDs" : "unavailable",
      fields: Object.entries(f)
        .filter(([name]) => name !== "positions")
        .map(([name, a]) => ({
          name,
          components: a.shape[1] ?? 1,
          dtype: a.data.constructor.name,
        })),
    };
  }
  checkIndex(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= this.times.length)
      throw new Error("Frame index is out of range.");
  }
  close() {}
}
export function displayFrame(
  raw: RawFrame,
  index: number,
  time: number,
  field: string,
): Frame {
  validateRaw(raw);
  if (!raw[field])
    throw new Error(`Field ${field} is missing from this frame.`);
  const arrays: Frame["arrays"] = {};
  let bytes = 0;
  for (const [name, a] of Object.entries(raw)) {
    if (!baseFields.includes(name) && name !== field) continue;
    let data: NumericArray;
    if (a.data instanceof BigInt64Array) data = a.data.slice();
    else if (a.data instanceof BigUint64Array) {
      if (a.data.some((v) => v > 0x7fffffffffffffffn))
        throw new Error("Unsigned identities above int64 are not supported.");
      data = BigInt64Array.from(a.data);
    } else if (a.data instanceof Float32Array || a.data instanceof Float64Array)
      data = Float32Array.from(a.data);
    else if (
      a.data instanceof Uint32Array &&
      a.data.some((v) => v > 2147483647)
    )
      data = BigInt64Array.from(a.data, BigInt);
    else data = Int32Array.from(a.data);
    if (name === "positions")
      for (const value of data)
        if (!Number.isFinite(Number(value)))
          throw new Error("Positions exceed the display float32 range.");
    arrays[name] = { data, shape: a.shape };
    bytes += data.byteLength;
  }
  return { index, time, arrays, bytes };
}
export function reduceDiagnostic(
  f: RawFrame,
  index: number,
  time: number,
): Diagnostic {
  validateRaw(f);
  const n = f.positions.shape[0],
    v = f.velocities,
    m = f.masses,
    rho = f.densities,
    k = f.kinds.data;
  let particles = 0,
    ke = 0,
    maxSpeed = 0,
    sumDensity = 0,
    energyValid = !!v && !!m,
    speedValid = !!v,
    densityValid = !!rho;
  for (let i = 0; i < n; i++) {
    if (Number(k[i]) !== 0) continue;
    particles++;
    if (rho) {
      const r = Number(rho.data[i]);
      sumDensity += r;
      densityValid &&= Number.isFinite(r);
    }
    if (v) {
      let v2 = 0;
      for (let c = 0; c < (v.shape[1] ?? 1); c++)
        v2 += Number(v.data[i * (v.shape[1] ?? 1) + c]) ** 2;
      speedValid &&= Number.isFinite(v2);
      maxSpeed = Math.max(maxSpeed, Math.sqrt(v2));
      if (m) {
        const mass = Number(m.data[i]);
        energyValid &&=
          Number.isFinite(mass) && mass >= 0 && Number.isFinite(v2);
        ke += 0.5 * mass * v2;
      }
    }
  }
  return {
    index,
    time,
    particles,
    kineticEnergy: particles && energyValid && Number.isFinite(ke) ? ke : null,
    maxSpeed: particles && speedValid ? maxSpeed : null,
    meanDensity: particles && densityValid ? sumDensity / particles : null,
  };
}
export class DemoSource extends RawSource {
  p: Float32Array;
  dim: 2 | 3;
  dx: number;
  constructor(dim: 2 | 3) {
    super(`demo-${dim}d`);
    this.dim = dim;
    this.name = `Taylor–Green · ${dim}D analytical`;
    this.format = "Analytical demo";
    const n = dim === 2 ? 96 : 24;
    this.dx = (2 * Math.PI) / n;
    this.times = Array.from({ length: 121 }, (_, i) => i * 0.05);
    const p: number[] = [];
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++)
        for (let z = 0; z < (dim === 3 ? n : 1); z++) {
          const a = (x + 0.5) * this.dx,
            b = (y + 0.5) * this.dx,
            c = (z + 0.5) * this.dx;
          if (
            dim === 3 &&
            Math.hypot(a - Math.PI, b - Math.PI, c - Math.PI) >= Math.PI * 0.93
          )
            continue;
          p.push(a, b);
          if (dim === 3) p.push(c);
        }
    this.p = Float32Array.from(p);
  }
  read(index: number): RawFrame {
    this.checkIndex(index);
    const n = this.p.length / this.dim,
      v = new Float32Array(this.p.length),
      rho = new Float32Array(n),
      pressure = new Float32Array(n),
      amp = Math.exp(-0.15 * this.times[index]);
    for (let i = 0; i < n; i++) {
      const x = this.p[i * this.dim],
        y = this.p[i * this.dim + 1],
        z = this.dim === 3 ? Math.cos(this.p[i * this.dim + 2]) : 1;
      v[i * this.dim] = Math.sin(x) * Math.cos(y) * amp * z;
      v[i * this.dim + 1] = -Math.cos(x) * Math.sin(y) * amp * z;
      pressure[i] =
        0.25 * (Math.cos(2 * x) + Math.cos(2 * y)) * amp * amp * z * z;
      rho[i] = 1 + 0.03 * Math.cos(2 * x) * Math.cos(2 * y) * amp;
    }
    return {
      positions: { data: this.p, shape: [n, this.dim] },
      velocities: { data: v, shape: [n, this.dim] },
      densities: { data: rho, shape: [n] },
      pressures: { data: pressure, shape: [n] },
      kinds: { data: new Int32Array(n), shape: [n] },
      UIDs: {
        data: BigInt64Array.from({ length: n }, (_, i) => BigInt(i)),
        shape: [n],
      },
      masses: {
        data: new Float32Array(n).fill(this.dx ** this.dim),
        shape: [n],
      },
      supports: { data: new Float32Array(n).fill(this.dx * 2), shape: [n] },
    };
  }
}
