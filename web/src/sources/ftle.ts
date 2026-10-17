import type { RawFrame } from "./core";
import { deformation, type MaterialSeed } from "./material";
import { mappedCoordinate, spatialDifference, type Domain } from "../spatial";
export interface FTLEQuery {
  start: number;
  end: number;
  resolution: 32 | 64 | 128;
  radius: number;
  neighbours: number;
  maxResidual: number;
}
export interface FTLEBatch {
  offset: number;
  values: Float32Array;
  residual: Float32Array;
  condition: Float32Array;
  counts: Uint8Array;
  uids: (string | null)[];
  bounds: number[][];
  width: number;
  height: number;
}
export function validateFTLE(q: FTLEQuery) {
  if (
    !Number.isInteger(q.start) ||
    q.start < 0 ||
    !Number.isInteger(q.end) ||
    q.end < 0 ||
    q.start === q.end ||
    ![32, 64, 128].includes(q.resolution) ||
    !(q.radius > 0 && Number.isFinite(q.radius)) ||
    !Number.isInteger(q.neighbours) ||
    q.neighbours < 3 ||
    q.neighbours > 64 ||
    !(q.maxResidual > 0 && q.maxResidual <= 1)
  )
    throw new Error(
      "Invalid FTLE map settings; choose different start/end frames, 3–64 neighbours and a positive radius.",
    );
}
/** A bounded CPU reference for a raster sampled at nearest recorded material centers.
 * The map is located at t0; no time-dependent velocity integration is implied. */
export class MaterialFTLE {
  private lookup = new Map<string, number>();
  private buckets = new Map<string, number[]>();
  private ids: (string | null)[];
  private work = 0;
  private bins: number[];
  private domain: Domain;
  readonly width: number;
  readonly height: number;
  readonly bounds: number[][];
  constructor(
    private first: RawFrame,
    private last: RawFrame,
    private q: FTLEQuery,
    private t0: number,
    private t1: number,
    domain?: Domain,
  ) {
    validateFTLE(q);
    if (
      first.positions.shape[1] !== 2 ||
      last.positions.shape[1] !== 2 ||
      !first.UIDs ||
      !last.UIDs
    )
      throw new Error(
        "FTLE maps require two-dimensional exact-UID recordings.",
      );
    if (!Number.isFinite(t1 - t0) || t1 === t0)
      throw new Error("FTLE needs a nonzero physical-time horizon.");
    if (first.positions.shape[0] > 300000 || last.positions.shape[0] > 300000)
      throw new Error(
        "The reference FTLE map is limited to 300,000 particles per endpoint.",
      );
    const id = (v: number | bigint) =>
      typeof v === "bigint"
        ? String(v)
        : Number.isSafeInteger(v)
          ? String(v)
          : null;
    const duplicate = new Set<string>();
    this.ids = Array.from({ length: first.UIDs.data.length }, (_, i) =>
      id(first.UIDs!.data[i]),
    );
    const seen = new Set<string>();
    for (const uid of this.ids)
      if (uid != null) {
        if (seen.has(uid)) duplicate.add(uid);
        seen.add(uid);
      }
    this.ids = this.ids.map((uid) =>
      uid != null && !duplicate.has(uid) ? uid : null,
    );
    const missing = new Set<string>();
    for (let i = 0; i < last.UIDs.data.length; i++) {
      const uid = id(last.UIDs.data[i]);
      if (uid == null) continue;
      if (this.lookup.has(uid)) missing.add(uid);
      else this.lookup.set(uid, i);
    }
    for (const uid of missing) this.lookup.delete(uid);
    const lo = [Infinity, Infinity],
      hi = [-Infinity, -Infinity];
    for (let i = 0; i < first.positions.shape[0]; i++)
      if (Number(first.kinds.data[i]) === 0)
        for (let c = 0; c < 2; c++) {
          const v = Number(first.positions.data[2 * i + c]);
          if (Number.isFinite(v)) {
            lo[c] = Math.min(lo[c], v);
            hi[c] = Math.max(hi[c], v);
          }
        }
    this.domain = domain ?? { min: lo, max: hi, periodic: [false, false] };
    this.bounds = [this.domain.min, this.domain.max];
    const span = this.bounds[1].map((v, c) => v - this.bounds[0][c]);
    if (span.some((v) => !(v > 0 && Number.isFinite(v))))
      throw new Error("FTLE map has invalid spatial bounds.");
    if (q.radius < Math.max(...span) * 1e-6)
      throw new Error("FTLE radius is too small for stable spatial indexing.");
    this.width = Math.max(
      2,
      Math.round((q.resolution * span[0]) / Math.max(...span)),
    );
    this.height = Math.max(
      2,
      Math.round((q.resolution * span[1]) / Math.max(...span)),
    );
    this.bins = span.map((v) => Math.max(1, Math.floor(v / q.radius)));
    for (let i = 0; i < first.positions.shape[0]; i++)
      if (this.ids[i] != null && Number(first.kinds.data[i]) === 0) {
        const point = this.point(first, i);
        if (!point) continue;
        const key = this.key(point);
        const list = this.buckets.get(key) ?? [];
        list.push(i);
        this.buckets.set(key, list);
      }
  }
  private point(frame: RawFrame, i: number) {
    const p = [
      Number(frame.positions.data[2 * i]),
      Number(frame.positions.data[2 * i + 1]),
    ];
    return p.every(Number.isFinite) ? p : null;
  }
  private cell(p: number[]) {
    return p.map((v, c) =>
      Math.max(
        0,
        Math.min(
          this.bins[c] - 1,
          Math.floor(
            ((mappedCoordinate(v, c, this.domain) - this.bounds[0][c]) /
              (this.bounds[1][c] - this.bounds[0][c])) *
              this.bins[c],
          ),
        ),
      ),
    );
  }
  private key(p: number[]) {
    return this.cell(p).join(":");
  }
  private neighbours(p: number[], r: number) {
    const cell = this.cell(p),
      found: { index: number; distance: number }[] = [],
      keys = new Set<string>();
    // Cell widths are >= query radius, so the 3x3 stencil is complete.
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const xy = [cell[0] + x, cell[1] + y];
        let valid = true;
        for (let c = 0; c < 2; c++) {
          if (this.domain.periodic[c])
            xy[c] = ((xy[c] % this.bins[c]) + this.bins[c]) % this.bins[c];
          else if (xy[c] < 0 || xy[c] >= this.bins[c]) valid = false;
        }
        if (!valid) continue;
        const key = xy.join(":");
        if (keys.has(key)) continue;
        keys.add(key);
        for (const i of this.buckets.get(key) ?? []) {
          if (++this.work > 2000000)
            throw new Error(
              "FTLE batch exceeds its work limit. Reduce the neighbourhood radius.",
            );
          const point = this.point(this.first, i)!;
          const distance = point.reduce(
            (sum, v, c) =>
              sum + spatialDifference(v, p[c], c, this.domain) ** 2,
            0,
          );
          if (distance <= r * r) found.push({ index: i, distance });
        }
      }
    found.sort((a, b) => a.distance - b.distance || a.index - b.index);
    return found;
  }
  batch(offset: number, count: number): FTLEBatch {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 128
    )
      throw new Error("Invalid bounded FTLE batch.");
    this.work = 0;
    const n = Math.max(0, Math.min(count, this.width * this.height - offset)),
      values = new Float32Array(n).fill(NaN),
      residual = new Float32Array(n).fill(NaN),
      condition = new Float32Array(n).fill(NaN),
      counts = new Uint8Array(n),
      uids: (string | null)[] = Array(n).fill(null),
      span = this.bounds[1].map((v, c) => v - this.bounds[0][c]);
    for (let k = 0; k < n; k++) {
      const i = offset + k,
        point = [
          this.bounds[0][0] + (((i % this.width) + 0.5) * span[0]) / this.width,
          this.bounds[0][1] +
            ((Math.floor(i / this.width) + 0.5) * span[1]) / this.height,
        ],
        candidate = this.neighbours(point, this.q.radius)[0];
      if (
        !candidate ||
        candidate.distance >
          Math.min(
            this.q.radius,
            1.5 * Math.hypot(span[0] / this.width, span[1] / this.height),
          ) **
            2
      )
        continue;
      const center = this.point(this.first, candidate.index)!,
        list = this.neighbours(center, this.q.radius)
          .filter((v) => v.index !== candidate.index)
          .slice(0, this.q.neighbours),
        indices = [candidate.index, ...list.map((v) => v.index)],
        positions = indices.map((i) => this.point(this.first, i));
      const seed: MaterialSeed = {
        index: this.q.start,
        time: this.t0,
        uids: indices.map((i) => this.ids[i]!),
        positions,
        fitCount: indices.length,
        relative: positions.map((p) =>
          p!.map((v, c) => spatialDifference(v, center[c], c, this.domain)),
        ),
      };
      const final = seed.uids.map((uid) => {
        const row = this.lookup.get(uid);
        return row == null ? null : this.point(this.last, row);
      });
      const d = deformation(
        seed,
        { index: this.q.end, time: this.t1, positions: final },
        this.q.maxResidual,
      );
      residual[k] = d.residual ?? NaN;
      condition[k] = d.condition ?? NaN;
      counts[k] = d.neighbours;
      uids[k] = seed.uids[0];
      if (
        d.ftle != null &&
        d.residual != null &&
        d.residual <= this.q.maxResidual
      )
        values[k] = d.ftle;
    }
    return {
      offset,
      values,
      residual,
      condition,
      counts,
      uids,
      bounds: this.bounds,
      width: this.width,
      height: this.height,
    };
  }
}

/** Explicit sampled scalar-ridge criterion; never described as a material LCS proof. */
export function ridgeMask(
  values: Float32Array,
  w: number,
  h: number,
  threshold: number,
) {
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x,
        v = values[i];
      if (!Number.isFinite(v) || v < threshold) continue;
      const a = values[i - 1],
        b = values[i + 1],
        c = values[i - w],
        d = values[i + w];
      if (
        [a, b, c, d].every(Number.isFinite) &&
        ((v > a && v >= b) || (v > c && v >= d))
      )
        mask[i] = 1;
    }
  return mask;
}
