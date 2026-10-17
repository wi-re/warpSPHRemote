import { type GridData } from "./grid";
export interface LICSettings {
  steps: number;
  seed: number;
  contrast: number;
}
export const initialLIC: LICSettings = { steps: 16, seed: 1, contrast: 1.8 };
export function validateLIC(settings: LICSettings) {
  if (
    !Number.isInteger(settings.steps) ||
    settings.steps < 4 ||
    settings.steps > 32 ||
    !Number.isInteger(settings.seed) ||
    settings.seed < 0 ||
    settings.seed > 65535 ||
    !(settings.contrast >= 0.5 && settings.contrast <= 4)
  )
    throw new Error("Invalid LIC settings.");
}
/** Identical u32 hash in the CPU oracle and WGSL, stable across trajectory frames. */
export function licNoise(x: number, y: number, seed: number) {
  let h =
    (Math.imul(x, 374761393) +
      Math.imul(y, 668265263) +
      Math.imul(seed, 1442695041)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 65535) / 65535;
}
/** Snap sub-1e-4-cell roundoff at lattice lines so CPU/f32 mask topology agrees. */
function sampleLICVelocity(grid: GridData, p: number[]): number[] | null {
  const size = [grid.width, grid.height],
    g = p.map(
      (v, c) =>
        ((v - grid.bounds[0][c]) / (grid.bounds[1][c] - grid.bounds[0][c])) *
          size[c] -
        0.5,
    ),
    base = g.map((v) => Math.floor(v + 1e-4)),
    t = g.map((v, c) => Math.max(0, v - base[c]));
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
      out[0] += w * grid.velocity[2 * i];
      out[1] += w * grid.velocity[2 * i + 1];
    }
  return out.every(Number.isFinite) ? out : null;
}
export function computeLIC(
  grid: GridData,
  settings: LICSettings,
): Float32Array {
  validateLIC(settings);
  const { width: w, height: h, bounds, periodic } = grid,
    cell = [
      (bounds[1][0] - bounds[0][0]) / w,
      (bounds[1][1] - bounds[0][1]) / h,
    ],
    step = 0.6 * Math.min(...cell),
    out = new Float32Array(w * h).fill(NaN);
  const noise = (p: number[]) => {
    const g = p.map((v, c) => (v - bounds[0][c]) / cell[c] - 0.5),
      base = g.map(Math.floor),
      t = g.map((v, c) => v - base[c]);
    let sum = 0;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const xy = [base[0] + x, base[1] + y];
        for (let c = 0; c < 2; c++) {
          const n = c === 0 ? w : h;
          xy[c] = periodic[c]
            ? ((xy[c] % n) + n) % n
            : Math.max(0, Math.min(n - 1, xy[c]));
        }
        sum +=
          licNoise(xy[0], xy[1], settings.seed) *
          (x ? t[0] : 1 - t[0]) *
          (y ? t[1] : 1 - t[1]);
      }
    return sum;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        origin = [
          bounds[0][0] + (x + 0.5) * cell[0],
          bounds[0][1] + (y + 0.5) * cell[1],
        ],
        v = sampleLICVelocity(grid, origin);
      if (
        !v ||
        Math.hypot(...v) < 1e-12 ||
        (!periodic[0] && (x < 1 || x >= w - 2)) ||
        (!periodic[1] && (y < 1 || y >= h - 2))
      )
        continue;
      let sum = licNoise(x, y, settings.seed),
        weight = 1;
      for (const sign of [-1, 1]) {
        let p = [...origin];
        for (let j = 1; j <= settings.steps; j++) {
          const v = sampleLICVelocity(grid, p);
          if (!v) break;
          const speed = Math.hypot(...v);
          if (speed < 1e-12) break;
          const middle = [0, 0];
          // Fixed arc-length midpoint integration; units cancel after normalization.
          middle[0] = p[0] + (sign * step * 0.5 * v[0]) / speed;
          middle[1] = p[1] + (sign * step * 0.5 * v[1]) / speed;
          const mv = sampleLICVelocity(grid, middle);
          if (!mv) break;
          const ms = Math.hypot(...mv);
          if (ms < 1e-12) break;
          const next = p.map((value, c) => value + (sign * step * mv[c]) / ms);
          if (!sampleLICVelocity(grid, next)) break;
          const n = noise(next);
          if (n == null) break;
          const win =
            0.5 + 0.5 * Math.cos((Math.PI * j) / (settings.steps + 1));
          sum += win * n;
          weight += win;
          p = next;
        }
      }
      out[i] = Math.max(
        0,
        Math.min(1, 0.5 + (sum / weight - 0.5) * settings.contrast),
      );
    }
  return out;
}
