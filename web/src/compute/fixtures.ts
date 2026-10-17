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

/** A regular fluid lattice for manufactured affine-flow checks. */
export function velocityFixture(
  velocity: (x: number, y: number) => number[],
  side = 36,
): RawFrame {
  const n = side * side,
    positions = new Float64Array(n * 2),
    velocities = new Float64Array(n * 2);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const p = [-1 + ((x + 0.5) * 2) / side, -1 + ((y + 0.5) * 2) / side],
        i = y * side + x;
      positions.set(p, 2 * i);
      velocities.set(velocity(p[0], p[1]), 2 * i);
    }
  return {
    positions: { data: positions, shape: [n, 2] },
    velocities: { data: velocities, shape: [n, 2] },
    masses: { data: new Float64Array(n).fill((2 / side) ** 2), shape: [n] },
    densities: { data: new Float64Array(n).fill(1), shape: [n] },
    supports: { data: new Float64Array(n).fill(0.3), shape: [n] },
    kinds: { data: new Int32Array(n), shape: [n] },
  };
}
export const velocityDomain = {
  domain: { min: [-1, -1], max: [1, 1], periodic: [false, false] },
};
