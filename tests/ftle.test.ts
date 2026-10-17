import test from "node:test";
import assert from "node:assert/strict";
import {
  MaterialFTLE,
  ridgeMask,
  type FTLEQuery,
} from "../web/src/sources/ftle";
import type { RawFrame } from "../web/src/sources/core";
const points = Array.from({ length: 25 * 25 }, (_, i) => [
  ((i % 25) + 0.5) / 25,
  (Math.floor(i / 25) + 0.5) / 25,
]);
const raw = (
  points: number[][],
  ids = points.map((_, i) => BigInt(i)),
): RawFrame => ({
  positions: {
    data: Float64Array.from(points.flat()),
    shape: [points.length, 2],
  },
  UIDs: { data: BigInt64Array.from(ids), shape: [ids.length] },
  kinds: { data: new Int32Array(points.length), shape: [points.length] },
});
const q: FTLEQuery = {
  start: 0,
  end: 1,
  resolution: 32,
  radius: 0.15,
  neighbours: 16,
  maxResidual: 0.25,
};
function all(context: MaterialFTLE) {
  const output = new Float32Array(context.width * context.height);
  for (let i = 0; i < output.length; i += 128)
    output.set(context.batch(i, 128).values, i);
  return output;
}
const domain = { min: [0, 0], max: [1, 1], periodic: [false, false] };
test("sampled material FTLE maps recover affine expansion, rotation, shear and contraction", () => {
  for (const F of [
    [2, 0, 0, 0.5],
    [0, -1, 1, 0],
    [1, 2, 0, 1],
    [0.5, 0, 0, 0.5],
  ]) {
    const final = points.map(([x, y]) => [
      F[0] * x + F[1] * y + 3,
      F[2] * x + F[3] * y - 2,
    ]);
    const values = all(
      new MaterialFTLE(raw(points), raw(final), q, 0, 2, domain),
    );
    const a = F[0] ** 2 + F[2] ** 2,
      b = F[0] * F[1] + F[2] * F[3],
      c = F[1] ** 2 + F[3] ** 2,
      expected =
        Math.log(Math.sqrt((a + c + Math.hypot(a - c, 2 * b)) / 2)) / 2;
    assert.ok(
      values.every((v) => Number.isFinite(v) && Math.abs(v - expected) < 1e-6),
    );
  }
});
test("field results survive shuffled exact UIDs and preserve periodic multi-box translation", () => {
  const periodic = { ...domain, periodic: [true, true] },
    final = points.map(([x, y]) => [x + 3.7, y - 2.4]);
  const context = new MaterialFTLE(
    raw(points),
    raw(
      final.slice().reverse(),
      points.map((_, i) => BigInt(points.length - 1 - i)),
    ),
    { ...q, start: 1, end: 0 },
    2,
    0,
    periodic,
  );
  assert.ok(
    all(context).every((v) => Number.isFinite(v) && Math.abs(v) < 1e-6),
  );
});
test("FTLE maps mask missing centers, insufficient rank, residual and empty coverage", () => {
  const missing = points.map(([x, y]) => [x, y]),
    ids = points.map((_, i) => BigInt(i));
  for (let i = 0; i < ids.length; i++) if (points[i][0] > 0.5) ids[i] += 10000n;
  const values = all(
    new MaterialFTLE(raw(points), raw(missing, ids), q, 0, 1, domain),
  );
  assert.ok(values.some(Number.isFinite));
  assert.ok(values.some(Number.isNaN));
  const nonlinear = points.map(([x, y], i) => [
    x + (i % 2 ? 0.1 : -0.1),
    y + (i % 3 ? 0.2 : -0.2),
  ]);
  const strict = all(
    new MaterialFTLE(
      raw(points),
      raw(nonlinear),
      { ...q, maxResidual: 0.01 },
      0,
      1,
      domain,
    ),
  );
  assert.ok(strict.every(Number.isNaN));
  const line = raw([
    [0.1, 0.5],
    [0.3, 0.5],
    [0.5, 0.5],
    [0.7, 0.5],
    [0.9, 0.5],
  ]);
  assert.ok(
    all(
      new MaterialFTLE(line, line, { ...q, radius: 0.5 }, 0, 1, domain),
    ).every(Number.isNaN),
  );
});
test("FTLE map validates horizon, dimensionality, work limits and reports provenance geometry", () => {
  assert.throws(
    () => new MaterialFTLE(raw(points), raw(points), q, 1, 1, domain),
    /horizon/,
  );
  const context = new MaterialFTLE(raw(points), raw(points), q, 0, 1, domain),
    batch = context.batch(0, 128);
  assert.deepEqual(batch.bounds, [
    [0, 0],
    [1, 1],
  ]);
  assert.equal(batch.width, 32);
  assert.ok(batch.counts.every((v) => v >= 3));
  assert.ok(batch.uids.every((v) => v != null));
  assert.throws(() => context.batch(0, 129), /bounded/);
});
test("coordinate-axis ridge candidates exclude flat areas, masks and values below threshold", () => {
  const values = Float32Array.from([
      0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 2, 4, 2, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0,
    ]),
    mask = ridgeMask(values, 5, 5, 3);
  assert.equal(mask[12], 1);
  assert.equal(
    mask.reduce((a, b) => a + b, 0),
    1,
  );
  assert.ok(ridgeMask(new Float32Array(25).fill(4), 5, 5, 3).every((v) => !v));
  values[11] = NaN;
  assert.equal(ridgeMask(values, 5, 5, 3)[12], 0);
});
