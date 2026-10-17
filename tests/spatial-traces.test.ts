import test from "node:test";
import assert from "node:assert/strict";
import {
  domainFrom,
  mappedPosition,
  spatialDifference,
} from "../web/src/spatial";
import { tracePosition, traceSegments } from "../web/src/sources/traces";
import { samplePressures, type PressureProbe } from "../web/src/sources/probes";
import type { RawFrame } from "../web/src/sources/core";
const domain = domainFrom([0, -1], [1, 1], [true, false]);
test("display wrapping preserves raw positions, handles many periods, and leaves nonperiodic axes unchanged", () => {
  const raw = [-2.25, 3];
  assert.deepEqual(mappedPosition(raw, domain), [0.75, 3]);
  assert.deepEqual(raw, [-2.25, 3]);
  assert.deepEqual(mappedPosition([3.25, 0], domain), [0.25, 0]);
  assert.deepEqual(mappedPosition([1, 0], domain), [0, 0]);
  assert.deepEqual(mappedPosition(raw, domain, false), raw);
  assert.ok(Math.abs(spatialDifference(2.98, 0.02, 0, domain) + 0.04) < 1e-12);
  assert.throws(() => domainFrom([0, 0], [0, 1], [true, true]), /Domain/);
});
test("particle traces follow exact UIDs across row reordering and preserve unwrapped positions", () => {
  const uid = 2n ** 55n + 3n;
  const a: RawFrame = {
    positions: { data: new Float64Array([2.3, 0, -1.4, 0]), shape: [2, 2] },
    UIDs: { data: new BigInt64Array([uid, 9n]), shape: [2] },
  };
  const b: RawFrame = {
    positions: { data: new Float64Array([-1.5, 0, 2.4, 0]), shape: [2, 2] },
    UIDs: { data: new BigInt64Array([9n, uid]), shape: [2] },
  };
  assert.deepEqual(tracePosition(a, String(uid)), [2.3, 0]);
  assert.deepEqual(tracePosition(b, String(uid)), [2.4, 0]);
  assert.equal(tracePosition(a, "7"), null);
  assert.equal(tracePosition({ positions: a.positions }, String(uid)), null);
});
test("trace windows separate past/future and break missing identities and wrapped seams", () => {
  const rows = [0.8, 0.9, 1.1, 1.2].map((x, index) => ({
    index,
    time: index * 0.13,
    position: [x, 0],
  }));
  const wrapped = traceSegments(rows, 1, domain, true);
  assert.equal(wrapped.past.length, 6);
  assert.equal(wrapped.future.length, 6); // crossing is omitted
  const unwrapped = traceSegments(rows, 1, domain, false);
  assert.equal(unwrapped.future.length, 12);
  assert.equal(unwrapped.future[3], 1.1);
  assert.equal(
    traceSegments([{ ...rows[0], position: null }, rows[1]], 1, domain).past
      .length,
    0,
  );
  assert.equal(traceSegments([rows[0], rows[2]], 2, domain).past.length, 0);
});
test("pressure probes use minimum-image distances with unwrapped recorded coordinates", () => {
  const f: RawFrame = {
    positions: { data: new Float64Array([2.98, 0]), shape: [1, 2] },
    pressures: { data: new Float32Array([42]), shape: [1] },
  };
  const p: PressureProbe = {
    id: "p",
    name: "p",
    position: [0.02, 0],
    radius: 0.05,
    method: "nearest",
  };
  assert.equal(samplePressures(f, [p]).p, null);
  assert.equal(samplePressures(f, [p], domain).p, 42);
});
