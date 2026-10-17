import type { LICSettings } from "./lic";
import type { RawFrame } from "./core";
import { validateRaw } from "./core";
import type { Mapping, Source } from "../types";
import { mappedCoordinate, spatialDifference, type Domain } from "../spatial";
export type GridQuantity = "field" | "divergence" | "vorticity";
export const derivativeQuantity = (quantity?: GridQuantity) =>
  quantity === "divergence" || quantity === "vorticity";
export const gridQuantityLabel = (quantity?: GridQuantity) =>
  quantity === "divergence"
    ? "Velocity divergence · ∂u/∂x + ∂v/∂y"
    : quantity === "vorticity"
      ? "Vorticity · ∂v/∂x − ∂u/∂y"
      : "Recorded quantity";
export interface GridSettings {
  resolution: number;
  kernel: "wendland2" | "wendland4";
  minCoverage: number;
  wrapPeriodic: boolean;
  backend?: "auto" | "webgpu" | "cpu";
  quantity?: GridQuantity;
}
export const validGridResolution = (value: number) =>
  Number.isInteger(value) && value >= 8 && value <= 2048;
export const initialGrid: GridSettings = {
  resolution: 256,
  kernel: "wendland2",
  minCoverage: 0.2,
  wrapPeriodic: true,
  backend: "auto",
  quantity: "field",
};
export interface GridData {
  quantity?: GridQuantity;
  index: number;
  time: number;
  width: number;
  height: number;
  bounds: number[][];
  periodic: boolean[];
  values: Float32Array;
  velocity: Float32Array;
  coverage: Float32Array;
  velocityValid: Uint8Array;
  excluded: number;
  compute?: {
    backend: "webgpu" | "cpu";
    milliseconds: number;
    reason?: string;
    adapter?: string;
  };
}
export const categoricalField = (name: string) =>
  ["kinds", "UIDs", "materials"].includes(name);
/** Shared geometry/validation for the f64 CPU and f32 GPU implementations. */
export function gridLayout(
  raw: RawFrame,
  source: Pick<Source, "domain">,
  field: string,
  mapping: Mapping,
  settings: GridSettings,
) {
  validateRaw(raw);
  if (raw.positions.shape[1] !== 2)
    throw new Error("Grid reconstruction currently supports 2D recordings.");
  if (categoricalField(field))
    throw new Error(
      "Choose a continuous scalar or vector field for grid reconstruction.",
    );
  if (
    !validGridResolution(settings.resolution) ||
    !["wendland2", "wendland4"].includes(settings.kernel) ||
    !["field", "divergence", "vorticity"].includes(
      settings.quantity ?? "field",
    ) ||
    !(settings.minCoverage > 0 && settings.minCoverage <= 1)
  )
    throw new Error("Invalid grid settings.");
  const {
      positions: p,
      masses: m,
      densities: rho,
      supports: h,
      kinds: k,
    } = raw,
    f = raw[field],
    v = raw.velocities;
  if (!f || !m || !rho || !h)
    throw new Error(
      "Grid reconstruction requires the selected field, masses, densities and supports.",
    );
  if (derivativeQuantity(settings.quantity) && (!v || (v.shape[1] ?? 0) < 2))
    throw new Error(
      "Velocity derivatives require a recorded two-component velocity array.",
    );
  const n = p.shape[0],
    components = f.shape[1] ?? 1,
    component = { x: 0, y: 1, z: 2 }[mapping as "x" | "y" | "z"];
  if (components > 1 && mapping !== "magnitude" && component >= components)
    throw new Error("The selected vector component was not recorded.");
  const lo = [Infinity, Infinity],
    hi = [-Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) {
      lo[c] = Math.min(lo[c], Number(p.data[2 * i + c]));
      hi[c] = Math.max(hi[c], Number(p.data[2 * i + c]));
    }
  if (settings.wrapPeriodic && source.domain)
    for (let c = 0; c < 2; c++) {
      lo[c] = source.domain.min[c];
      hi[c] = source.domain.max[c];
    }
  for (let c = 0; c < 2; c++)
    if (hi[c] === lo[c]) {
      lo[c] -= 0.5;
      hi[c] += 0.5;
    }
  const periodic = source.domain?.periodic.map(
    (x) => x && settings.wrapPeriodic,
  ) ?? [false, false];
  const domain: Domain = { min: lo, max: hi, periodic };
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]),
    width = Math.max(
      2,
      Math.round((settings.resolution * (hi[0] - lo[0])) / span),
    ),
    height = Math.max(
      2,
      Math.round((settings.resolution * (hi[1] - lo[1])) / span),
    );
  if (!Number.isFinite(span) || span <= 0)
    throw new Error("Grid bounds are not finite.");
  return { n, components, component, lo, hi, periodic, domain, width, height };
}
/** Shepard-normalized SPH reconstruction. supports are compact cutoff radii. */
export function reconstructGrid(
  raw: RawFrame,
  source: Pick<Source, "domain">,
  field: string,
  mapping: Mapping,
  settings: GridSettings,
  index = 0,
  time = 0,
): GridData {
  const { n, components, component, lo, hi, periodic, domain, width, height } =
    gridLayout(raw, source, field, mapping, settings);
  const {
      positions: p,
      masses: m,
      densities: rho,
      supports: h,
      kinds: k,
    } = raw,
    f = raw[field],
    v = raw.velocities;
  const dx = (hi[0] - lo[0]) / width,
    dy = (hi[1] - lo[1]) / height,
    count = width * height;
  const weights = new Float64Array(count),
    sums = new Float64Array(count * components),
    velocitySums = new Float64Array(count * 2),
    bad = new Uint8Array(count),
    badV = new Uint8Array(count);
  const derived = derivativeQuantity(settings.quantity),
    gradientSums = derived ? new Float64Array(count * 4) : null,
    weightGradients = derived ? new Float64Array(count * 2) : null;
  let anchor: number[] | undefined;
  let excluded = 0,
    work = 0;
  for (let i = 0; i < n; i++) {
    if (Number(k.data[i]) !== 0) continue;
    const support = Number(h.data[i]),
      mass = Number(m.data[i]),
      density = Number(rho.data[i]);
    if (
      !Number.isFinite(support) ||
      support <= 0 ||
      !Number.isFinite(mass) ||
      mass <= 0 ||
      !Number.isFinite(density) ||
      density <= 0
    ) {
      excluded++;
      continue;
    }
    const vx = Number(v?.data[i * (v.shape[1] ?? 0)]),
      vy = Number(v?.data[i * (v.shape[1] ?? 0) + 1]),
      goodVelocity =
        !!v &&
        (v.shape[1] ?? 0) >= 2 &&
        Number.isFinite(vx) &&
        Number.isFinite(vy);
    if (goodVelocity && !anchor) anchor = [vx, vy];
    const x = mappedCoordinate(Number(p.data[2 * i]), 0, domain),
      y = mappedCoordinate(Number(p.data[2 * i + 1]), 1, domain);
    let x0 = Math.floor((x - support - lo[0]) / dx - 0.5),
      x1 = Math.ceil((x + support - lo[0]) / dx - 0.5),
      y0 = Math.floor((y - support - lo[1]) / dy - 0.5),
      y1 = Math.ceil((y + support - lo[1]) / dy - 0.5);
    if (!periodic[0]) {
      x0 = Math.max(0, x0);
      x1 = Math.min(width - 1, x1);
    } else x1 = Math.min(x1, x0 + width - 1);
    if (!periodic[1]) {
      y0 = Math.max(0, y0);
      y1 = Math.min(height - 1, y1);
    } else y1 = Math.min(y1, y0 + height - 1);
    const norm =
      (((settings.kernel === "wendland2" ? 7 : 9) /
        Math.PI /
        (support * support)) *
        mass) /
      density;
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) {
        if (++work > 40000000)
          throw new Error(
            "This grid exceeds the reconstruction work limit. Reduce grid resolution.",
          );
        const ix = ((gx % width) + width) % width,
          iy = ((gy % height) + height) % height;
        const rx = spatialDifference(lo[0] + (ix + 0.5) * dx, x, 0, domain),
          ry = spatialDifference(lo[1] + (iy + 0.5) * dy, y, 1, domain),
          q = Math.hypot(rx, ry) / support;
        if (q >= 1) continue;
        const weight =
            norm *
            (settings.kernel === "wendland2"
              ? (1 - q) ** 4 * (1 + 4 * q)
              : (1 - q) ** 6 * (1 + 6 * q + (35 / 3) * q * q)),
          j = iy * width + ix;
        weights[j] += weight;
        for (let c = 0; c < components; c++) {
          const value = Number(f.data[i * components + c]);
          if (!Number.isFinite(value)) bad[j] = 1;
          else sums[j * components + c] += weight * value;
        }
        if (goodVelocity) {
          // Accumulate offsets to a common velocity anchor for translation stability.
          const ux = vx - anchor![0],
            uy = vy - anchor![1];
          velocitySums[2 * j] += weight * ux;
          velocitySums[2 * j + 1] += weight * uy;
          if (derived) {
            const t = 1 - q,
              factor =
                (norm / (support * support)) *
                (settings.kernel === "wendland2"
                  ? -20 * t ** 3
                  : -(56 / 3) * (5 * q + 1) * t ** 5),
              wx = factor * rx,
              wy = factor * ry;
            weightGradients![2 * j] += wx;
            weightGradients![2 * j + 1] += wy;
            gradientSums![4 * j] += ux * wx;
            gradientSums![4 * j + 1] += ux * wy;
            gradientSums![4 * j + 2] += uy * wx;
            gradientSums![4 * j + 3] += uy * wy;
          }
        } else badV[j] = 1;
      }
  }
  const values = new Float32Array(count).fill(NaN),
    velocity = new Float32Array(count * 2).fill(NaN),
    coverage = Float32Array.from(weights),
    velocityValid = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (weights[i] < settings.minCoverage) continue;
    if (!derived && !bad[i]) {
      let value = 0;
      if (components === 1) value = sums[i] / weights[i];
      else if (mapping === "magnitude") {
        for (let c = 0; c < components; c++)
          value += (sums[i * components + c] / weights[i]) ** 2;
        value = Math.sqrt(value);
      } else value = sums[i * components + component] / weights[i];
      if (Number.isFinite(value)) values[i] = value;
    }
    if (!badV[i]) {
      const ux = velocitySums[2 * i] / weights[i],
        uy = velocitySums[2 * i + 1] / weights[i];
      velocity[2 * i] = anchor![0] + ux;
      velocity[2 * i + 1] = anchor![1] + uy;
      if (derived) {
        const gx = weightGradients![2 * i],
          gy = weightGradients![2 * i + 1];
        const value =
          settings.quantity === "divergence"
            ? (gradientSums![4 * i] -
                ux * gx +
                gradientSums![4 * i + 3] -
                uy * gy) /
              weights[i]
            : (gradientSums![4 * i + 2] -
                uy * gx -
                gradientSums![4 * i + 1] +
                ux * gy) /
              weights[i];
        if (Number.isFinite(value)) values[i] = value;
      }
      if (
        Number.isFinite(velocity[2 * i]) &&
        Number.isFinite(velocity[2 * i + 1])
      )
        velocityValid[i] = 1;
    }
  }
  return {
    quantity: settings.quantity ?? "field",
    index,
    time,
    width,
    height,
    bounds: [lo, hi],
    periodic,
    values,
    velocity,
    coverage,
    velocityValid,
    excluded,
  };
}
export function sampleVelocity(
  grid: GridData,
  point: number[],
): number[] | null {
  const size = [grid.width, grid.height],
    g = point.map(
      (v, c) =>
        ((v - grid.bounds[0][c]) / (grid.bounds[1][c] - grid.bounds[0][c])) *
          size[c] -
        0.5,
    ),
    base = g.map(Math.floor),
    t = g.map((v, c) => v - base[c]);
  const out = [0, 0];
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      const xy = [base[0] + x, base[1] + y];
      for (let c = 0; c < 2; c++) {
        if (grid.periodic[c]) xy[c] = ((xy[c] % size[c]) + size[c]) % size[c];
        else if (xy[c] < 0 || xy[c] >= size[c]) return null;
      }
      const i = xy[1] * grid.width + xy[0];
      if (!grid.velocityValid[i]) return null;
      const w = (x ? t[0] : 1 - t[0]) * (y ? t[1] : 1 - t[1]);
      for (let c = 0; c < 2; c++) out[c] += w * grid.velocity[2 * i + c];
    }
  return out.every(Number.isFinite) ? out : null;
}
export interface StreamSettings {
  seeds: number;
  steps: number;
}
export function streamlines(
  grid: GridData,
  settings: StreamSettings,
  manualSeeds?: number[][],
): Float32Array {
  const lo = grid.bounds[0],
    hi = grid.bounds[1],
    step =
      0.45 *
      Math.min((hi[0] - lo[0]) / grid.width, (hi[1] - lo[1]) / grid.height),
    points: number[] = [];
  const seeds =
    manualSeeds ??
    Array.from({ length: settings.seeds ** 2 }, (_, i) => [
      lo[0] + (((i % settings.seeds) + 0.5) / settings.seeds) * (hi[0] - lo[0]),
      lo[1] +
        ((Math.floor(i / settings.seeds) + 0.5) / settings.seeds) *
          (hi[1] - lo[1]),
    ]);
  const domain: Domain = { min: lo, max: hi, periodic: grid.periodic };
  for (const seed of seeds)
    for (const sign of [-1, 1]) {
      let p = [...seed];
      const visited = new Set<number>();
      for (let j = 0; j < settings.steps; j++) {
        const v = sampleVelocity(grid, p);
        if (!v) break;
        const speed = Math.hypot(...v);
        if (speed < 1e-12) break;
        const middle = p.map((x, c) => x + (sign * step * 0.5 * v[c]) / speed),
          mv = sampleVelocity(grid, middle);
        if (!mv) break;
        const ms = Math.hypot(...mv);
        if (ms < 1e-12) break;
        const next = p.map((x, c) => x + (sign * step * mv[c]) / ms);
        if (next.some((x, c) => !grid.periodic[c] && (x < lo[c] || x > hi[c])))
          break;
        if (!sampleVelocity(grid, next)) break;
        const a = p.map((x, c) => mappedCoordinate(x, c, domain)),
          b = next.map((x, c) => mappedCoordinate(x, c, domain));
        if (
          !grid.periodic.some(
            (periodic, c) =>
              periodic &&
              Math.floor((p[c] - lo[c]) / (hi[c] - lo[c])) !==
                Math.floor((next[c] - lo[c]) / (hi[c] - lo[c])),
          )
        )
          points.push(a[0], a[1], 0, b[0], b[1], 0);
        p = next;
        // Check loops sparsely, so one cell can contain several substeps.
        if (j % 8 === 0) {
          const ix = Math.floor(
              ((b[0] - lo[0]) / (hi[0] - lo[0])) * grid.width,
            ),
            iy = Math.floor(((b[1] - lo[1]) / (hi[1] - lo[1])) * grid.height),
            cell = iy * grid.width + ix;
          if (visited.has(cell)) break;
          visited.add(cell);
        }
      }
    }
  return Float32Array.from(points);
}

export interface FieldQuery {
  index: number;
  field: string;
  mapping: Mapping;
  settings: GridSettings;
  streams: StreamSettings | null;
  lic?: LICSettings;
  seed?: number[];
}
export interface FieldResult {
  grid: GridData;
  lic?: {
    values: Float32Array;
    backend: "cpu" | "webgpu";
    milliseconds: number;
    reason?: string;
  };
  lines: Float32Array;
  field: string;
  mapping: Mapping;
  sourceId: string;
}

/** Validate a completed grid against the current particle presentation. */
export function matchesFieldResult(
  result: FieldResult | null,
  sourceId: string | undefined,
  index: number | undefined,
  field: string,
  mapping: Mapping | undefined,
  mode: "particles" | "grid" | "both",
) {
  if (!result || result.sourceId !== sourceId || result.grid.index !== index)
    return false;
  if (derivativeQuantity(result.grid.quantity) || mode === "particles")
    return result.field === "velocities" && result.mapping === "magnitude";
  return result.field === field && result.mapping === mapping;
}
