import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedMaterial,
  materialPositions,
  relativeMaterial,
  deformation,
  type MaterialSeed,
} from "../web/src/sources/material";
import type { RawFrame } from "../web/src/sources/core";
const raw = (
  positions: number[][],
  ids = positions.map((_, i) => BigInt(i)),
  kinds = positions.map(() => 0),
): RawFrame => ({
  positions: {
    data: Float64Array.from(positions.flat()),
    shape: [positions.length, 2],
  },
  UIDs: { data: BigInt64Array.from(ids), shape: [ids.length] },
  kinds: { data: Int32Array.from(kinds), shape: [kinds.length] },
  supports: {
    data: Float32Array.from(positions.map(() => 0.3)),
    shape: [positions.length],
  },
});
const settings = { mode: "nearest" as const, count: 8, radius: 0.1 };
const base = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];
const seed = seedMaterial(raw(base), "0", settings, 0, 1);
const mapped = (F: number[], t: number, translation = [3, -2]) => ({
  index: 1,
  time: t,
  positions: base.map(([x, y]) => [
    F[0] * x + F[1] * y + translation[0],
    F[2] * x + F[3] * y + translation[1],
  ]),
});
const close = (a: number | null | undefined, b: number, tol = 1e-10) =>
  assert.ok(a != null && Math.abs(a - b) < tol, `${a} != ${b}`);
test("material positions use exact large IDs and reject duplicates/missing/non-finite points", () => {
  const uid = 9007199254740993n,
    r = raw(
      [
        [1, 2],
        [3, 4],
        [5, 6],
        [NaN, 1],
      ],
      [uid, 2n, 2n, 3n],
    );
  assert.deepEqual(materialPositions(r, [String(uid), "2", "3", "999"]), [
    [1, 2],
    null,
    null,
    null,
  ]);
});
test("seed nearest/support/radius freezes fluid identities, with pins excluded from fit", () => {
  const r = raw(
    [
      [0, 0],
      [0.01, 0],
      [0.02, 0],
      [0.4, 0],
      [0.04, 0],
    ],
    [0n, 1n, 2n, 3n, 4n],
    [0, 1, 0, 0, 0],
  );
  const s = seedMaterial(
    r,
    "0",
    { ...settings, mode: "radius", radius: 0.03 },
    2,
    1,
    undefined,
    ["3"],
  );
  assert.deepEqual(s.uids, ["0", "2", "3"]);
  assert.equal(s.fitCount, 2);
  assert.deepEqual(
    seedMaterial(r, "0", { ...settings, mode: "support" }, 2, 1).uids,
    ["0", "2", "4"],
  );
});
test("matched material set survives row shuffling and missing neighbours", () => {
  const r = raw(
    base.slice().reverse(),
    base.map((_, i) => BigInt(8 - i)),
  );
  assert.deepEqual(materialPositions(r, seed.uids), seed.positions);
  const sample = mapped([2, 0, 0, 0.5], 3);
  sample.positions[1] = null as any;
  const result = deformation(seed, sample);
  close(result.ftle, Math.log(2) / 2);
  assert.equal(result.neighbours, 7);
});
test("rigid translation and rotation have zero FTLE; expansion/contraction retain signed rates", () => {
  for (const F of [
    [1, 0, 0, 1],
    [0, -1, 1, 0],
  ]) {
    const d = deformation(seed, mapped(F, 3));
    close(d.ftle, 0);
    close(d.residual, 0);
  }
  close(
    deformation(seed, mapped([Math.exp(0.8), 0, 0, Math.exp(-0.8)], 3)).ftle,
    0.4,
  );
  close(
    deformation(seed, mapped([0.5, 0, 0, 0.25], 3)).ftle,
    Math.log(0.5) / 2,
  );
  close(deformation(seed, mapped([2, 0, 0, 0.5], -1)).ftle, Math.log(2) / 2);
  assert.equal(
    deformation(seed, mapped([2, 0, 0, 0.5], -1)).direction,
    "backward",
  );
});
test("shear matches closed-form singular value and irregular physical-time horizon", () => {
  const k = 2,
    dt = 1.37,
    d = deformation(seed, mapped([1, k, 0, 1], 1 + dt));
  close(
    d.ftle,
    Math.log(Math.sqrt((2 + k * k + Math.sqrt(k ** 4 + 4 * k * k)) / 2)) / dt,
  );
  close(d.residual, 0);
});
test("rank-deficient neighbourhoods, absent center, zero duration are explicitly invalid", () => {
  const s = seedMaterial(
    raw([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]),
    "0",
    settings,
    0,
    0,
  );
  assert.match(
    deformation(s, { index: 1, time: 1, positions: s.positions }).reason!,
    /rank/,
  );
  assert.equal(
    deformation(seed, { index: 0, time: 1, positions: seed.positions }).ftle,
    null,
  );
  const sample = mapped([1, 0, 0, 1], 3);
  sample.positions[0] = null as any;
  assert.equal(deformation(seed, sample).ftle, null);
});
test("periodic branch is fixed initially and unwrapped relative travel is preserved", () => {
  const domain = { min: [0, 0], max: [1, 1], periodic: [true, true] },
    r = raw([
      [0.98, 0.5],
      [0.02, 0.5],
      [0.98, 0.54],
      [0.94, 0.5],
      [0.98, 0.46],
    ]);
  const s = seedMaterial(r, "0", settings, 0, 0, domain);
  const order = s.uids.map(Number),
    points = order.map((i) => [
      Number(r.positions.data[2 * i]) + 2.1,
      Number(r.positions.data[2 * i + 1]),
    ]);
  const relative = relativeMaterial(s, {
    index: 1,
    time: 1,
    positions: points,
  });
  for (let i = 0; i < relative.length; i++)
    for (let c = 0; c < 2; c++) close(relative[i]![c], s.relative[i]![c]);
  close(deformation(s, { index: 1, time: 1, positions: points }).ftle, 0);
  const stretch = points.map((p, i) => [p[0] + s.relative[i]![0] * 4, p[1]]);
  close(
    deformation(s, { index: 2, time: 2, positions: stretch }).ftle,
    Math.log(5) / 2,
  );
});
