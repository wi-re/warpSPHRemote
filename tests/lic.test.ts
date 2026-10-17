import test from "node:test";
import assert from "node:assert/strict";
import { computeLIC, initialLIC, licNoise } from "../web/src/sources/lic";
import type { GridData } from "../web/src/sources/grid";
export function licFixture(kind = "uniform", size = 32): GridData {
  const n = size * size,
    grid: GridData = {
      width: size,
      height: size,
      index: 0,
      time: 0,
      bounds: [
        [0, 0],
        [1, 1],
      ],
      periodic: [true, true],
      values: new Float32Array(n).fill(1),
      velocity: new Float32Array(n * 2),
      velocityValid: new Uint8Array(n).fill(1),
      coverage: new Float32Array(n).fill(1),
      excluded: 0,
    };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      grid.velocity[2 * i] =
        kind === "rotation"
          ? -(y + 0.5 - size / 2) / size
          : kind === "stagnant"
            ? 0
            : 1;
      grid.velocity[2 * i + 1] =
        kind === "rotation" ? (x + 0.5 - size / 2) / size : 0;
    }
  return grid;
}
test("LIC is deterministic, bounded, parameter-sensitive and uses stable integer noise", () => {
  const grid = licFixture(),
    a = computeLIC(grid, initialLIC),
    b = computeLIC(grid, initialLIC);
  assert.deepEqual(a, b);
  assert.ok(a.every((v) => v >= 0 && v <= 1));
  assert.notDeepEqual(a, computeLIC(grid, { ...initialLIC, seed: 9 }));
  assert.equal(licNoise(12, 22, 1), licNoise(12, 22, 1));
  assert.throws(() => computeLIC(grid, { ...initialLIC, steps: 100 }));
});
test("uniform-flow LIC smooths along the velocity direction and respects speed invariance", () => {
  const grid = licFixture(),
    a = computeLIC(grid, initialLIC);
  let along = 0,
    cross = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = y * 32 + x;
      along += Math.abs(a[i] - a[y * 32 + ((x + 1) % 32)]);
      cross += Math.abs(a[i] - a[((y + 1) % 32) * 32 + x]);
    }
  assert.ok(along < cross * 0.35, `${along} versus ${cross}`);
  grid.velocity = Float32Array.from(grid.velocity, (v) => v * 12);
  assert.deepEqual(computeLIC(grid, initialLIC), a);
});
test("stagnation, invalid velocity and dry gaps are masked; nonperiodic edges are conservative", () => {
  assert.ok(computeLIC(licFixture("stagnant"), initialLIC).every(Number.isNaN));
  const grid = licFixture();
  for (let y = 0; y < 32; y++) grid.velocityValid[y * 32 + 16] = 0;
  const out = computeLIC(grid, initialLIC);
  assert.ok(Number.isNaN(out[16 * 32 + 16]));
  assert.ok(Number.isFinite(out[16 * 32 + 8]));
  grid.periodic = [false, false];
  const boundary = computeLIC(grid, initialLIC);
  assert.ok(Number.isNaN(boundary[0]));
  assert.ok(Number.isFinite(boundary[16 * 32 + 8]));
});
