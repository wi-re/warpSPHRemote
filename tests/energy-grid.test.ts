import test from "node:test";
import assert from "node:assert/strict";
import { reduceDiagnostic, type RawFrame } from "../web/src/sources/core";
import {
  reconstructGrid,
  streamlines,
  sampleVelocity,
  initialGrid,
  type GridData,
} from "../web/src/sources/grid";
const close = (a: number, b: number, tol = 1e-5) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function raw(values = [2, 6, 999], masses = [2, 6, 999]): RawFrame {
  return {
    positions: {
      data: new Float64Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      shape: [3, 2],
    },
    kinds: { data: new Int32Array([0, 0, 1]), shape: [3] },
    masses: { data: Float64Array.from(masses), shape: [3] },
    densities: { data: new Float64Array([2, 2, 2]), shape: [3] },
    supports: { data: new Float64Array([0.4, 0.4, 0.4]), shape: [3] },
    test: { data: Float64Array.from(values), shape: [3] },
    velocities: {
      data: new Float64Array([1, 0, -1, 0, 99, 99]),
      shape: [3, 2],
    },
  };
}
const source = {
    domain: { min: [0, 0], max: [1, 1], periodic: [false, false] },
  },
  settings = { ...initialGrid, resolution: 128 as const };
test("internal/total energies are mass weighted, fluid-only and independently unavailable", () => {
  const f = raw();
  f.internalEnergies = { data: new Float64Array([3, 5, Infinity]), shape: [3] };
  const d = reduceDiagnostic(f, 0, 0);
  assert.equal(d.kineticEnergy, 4);
  assert.equal(d.internalEnergy, 36);
  assert.equal(d.totalEnergy, 40);
  f.velocities.data[0] = NaN;
  const badV = reduceDiagnostic(f, 0, 0);
  assert.equal(badV.kineticEnergy, null);
  assert.equal(badV.internalEnergy, 36);
  assert.equal(badV.totalEnergy, null);
  f.internalEnergies.data[0] = NaN;
  assert.equal(reduceDiagnostic(f, 0, 0).internalEnergy, null);
  delete f.internalEnergies;
  assert.equal(reduceDiagnostic(f, 0, 0).totalEnergy, null);
});
test("SPH grid normalizes by particle volume, masks dry regions and preserves constant fields", () => {
  const f = raw(),
    g = reconstructGrid(f, source, "test", "magnitude", settings);
  const i = 64 * g.width + 64;
  close(g.values[i], 5);
  assert.ok(Number.isNaN(g.values[0]));
  f.test.data[0] = f.test.data[1] = 2.5;
  for (const kernel of ["wendland2", "wendland4"] as const) {
    const c = reconstructGrid(f, source, "test", "magnitude", {
      ...settings,
      kernel,
    });
    assert.ok(c.values.some(Number.isFinite));
    for (const value of c.values) if (Number.isFinite(value)) close(value, 2.5);
  }
  const magnitude = reconstructGrid(
    f,
    source,
    "velocities",
    "magnitude",
    settings,
  );
  close(magnitude.values[i], 0.5); // norm of reconstructed vector, not mean of norms
});
test("variable cutoff support changes kernel weighting and invalid samples remain masked", () => {
  const f = raw([2, 6, 999], [2, 2, 999]);
  (f.positions.data as Float64Array).fill(0.50390625);
  f.supports.data[1] = 0.8;
  const g = reconstructGrid(f, source, "test", "magnitude", settings);
  close(g.values[64 * g.width + 64], 2.8);
  f.test.data[0] = NaN;
  assert.ok(
    Number.isNaN(
      reconstructGrid(f, source, "test", "magnitude", settings).values[
        64 * g.width + 64
      ],
    ),
  );
  assert.throws(
    () => reconstructGrid(f, source, "UIDs", "magnitude", settings),
    /continuous/,
  );
  delete f.supports;
  assert.throws(
    () => reconstructGrid(f, source, "test", "magnitude", settings),
    /supports/,
  );
});
test("periodic grid splats unwrapped particles across seams without rewriting positions", () => {
  const f = raw([3, 3, 999], [0.02, 0.02, 999]);
  f.positions.data[0] = f.positions.data[2] = 2.99;
  (f.supports.data as Float64Array).fill(0.1);
  const original = f.positions.data.slice(),
    domain = { min: [0, 0], max: [1, 1], periodic: [true, true] };
  const g = reconstructGrid(f, { domain }, "test", "magnitude", settings);
  close(g.values[64 * g.width], 3);
  close(g.values[64 * g.width + 127], 3);
  assert.deepEqual(f.positions.data, original);
});
function analytic(
  velocity: (x: number, y: number) => number[],
  periodic = [false, false],
): GridData {
  const width = 128,
    height = 128,
    v = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      v.set(
        velocity(-1 + (x + 0.5) / 64, -1 + (y + 0.5) / 64),
        (y * width + x) * 2,
      );
  return {
    index: 0,
    time: 0,
    width,
    height,
    bounds: [
      [-1, -1],
      [1, 1],
    ],
    periodic,
    values: new Float32Array(width * height),
    velocity: v,
    coverage: new Float32Array(width * height).fill(1),
    velocityValid: new Uint8Array(width * height).fill(1),
    excluded: 0,
  };
}
test("streamlines are straight in uniform flow and stop at a masked fluid gap", () => {
  const g = analytic(() => [1, 0]);
  assert.deepEqual(sampleVelocity(g, [0, 0]), [1, 0]);
  const line = streamlines(g, { seeds: 1, steps: 400 }, [[-0.5, 0]]);
  assert.ok(line.length > 0);
  for (let i = 1; i < line.length; i += 3) close(line[i], 0);
  for (let y = 0; y < 128; y++)
    for (let x = 59; x < 69; x++) g.velocityValid[y * 128 + x] = 0;
  const masked = streamlines(g, { seeds: 1, steps: 400 }, [[-0.5, 0]]);
  for (let i = 0; i < masked.length; i += 3) assert.ok(masked[i] < -0.07);
  assert.equal(
    streamlines(
      analytic(() => [0, 0]),
      { seeds: 1, steps: 400 },
      [[0, 0]],
    ).length,
    0,
  );
});
test("midpoint integration follows solid rotation and periodic lines never jump across the box", () => {
  const circle = streamlines(
    analytic((x, y) => [-y, x]),
    { seeds: 1, steps: 400 },
    [[0.4, 0]],
  );
  assert.ok(circle.length > 100);
  for (let i = 0; i < circle.length; i += 3)
    close(Math.hypot(circle[i], circle[i + 1]), 0.4, 0.0003);
  const periodic = streamlines(
    analytic(() => [1, 0], [true, false]),
    { seeds: 1, steps: 400 },
    [[0.99, 0]],
  );
  assert.ok(periodic.length > 100);
  for (let i = 0; i < periodic.length; i += 6)
    assert.ok(Math.abs(periodic[i + 3] - periodic[i]) < 0.02);
});
