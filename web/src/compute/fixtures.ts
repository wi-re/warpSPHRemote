import type { RawFrame } from "../sources/core";
/** Deterministic irregular particles, mixed kinds and variable compact supports. */
export function fixture(n = 157): RawFrame {
  const scalar = new Float64Array(n),
    positions = new Float64Array(n * 2),
    velocities = new Float64Array(n * 2),
    supports = new Float64Array(n),
    masses = new Float64Array(n),
    densities = new Float64Array(n),
    kinds = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 0.61803398875 + 0.011) % 1,
      y = (i * 0.41421356237 + 0.07) % 1;
    positions.set([x + ((i % 3) - 1) * 6, y + ((i % 5) - 2) * 3], i * 2);
    velocities.set([2 * x - y, 3 * y + x], i * 2);
    scalar[i] = 0.3 + x * 2 - y;
    supports[i] = 0.11 + (i % 7) * 0.019;
    masses[i] = 0.008 + (i % 3) * 0.001;
    densities[i] = 1 + 0.1 * y;
    kinds[i] = i % 13 === 0 ? 1 : i % 17 === 0 ? 2 : 0;
  }
  return {
    positions: { data: positions, shape: [n, 2] },
    velocities: { data: velocities, shape: [n, 2] },
    supports: { data: supports, shape: [n] },
    masses: { data: masses, shape: [n] },
    densities: { data: densities, shape: [n] },
    kinds: { data: kinds, shape: [n] },
    test: { data: scalar, shape: [n] },
  };
}
