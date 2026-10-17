import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFrame,
  scalarRange,
  scalarValues,
  diagnosticSeries,
} from "../web/src/data";
import type { Frame } from "../web/src/types";

test("fluid range excludes boundaries, invalid samples and nonpositive log values", () => {
  const values = new Float32Array([-1, 0, 2, 8, 500, NaN]);
  const kinds = new Int32Array([0, 0, 0, 0, 1, 0]);
  assert.deepEqual(scalarRange(values, kinds), [-1, 8]);
  assert.deepEqual(scalarRange(values, kinds, true), [2, 8]);
  assert.equal(scalarRange(new Float32Array([NaN, -2]), undefined, true), null);
  const constant = scalarRange(new Float32Array([3, 3]), undefined)!;
  assert.ok(constant[0] < 3 && constant[1] > 3);
});
test("vector mappings preserve components and compute magnitude", () => {
  const frame: Frame = {
    index: 0,
    time: 0,
    bytes: 0,
    arrays: {
      positions: { data: new Float32Array(4), shape: [2, 2] },
      v: { data: new Float32Array([3, 4, -5, 12]), shape: [2, 2] },
    },
  };
  assert.deepEqual([...scalarValues(frame, "v", "magnitude")], [5, 13]);
  assert.deepEqual([...scalarValues(frame, "v", "x")], [3, -5]);
  assert.ok([...scalarValues(frame, "v", "z")].every(Number.isNaN));
});
test("decoder reads aligned binary arrays and preserves 64-bit identities", () => {
  const header = {
    version: 1,
    index: 2,
    time: 0.3,
    arrays: {
      positions: { dtype: "<f4", shape: [1, 2], offset: 0, bytes: 8 },
      UIDs: { dtype: "<i8", shape: [1], offset: 8, bytes: 8 },
    },
  };
  const text = new TextEncoder().encode(JSON.stringify(header));
  const base = 8 + Math.ceil(text.length / 8) * 8;
  const packet = new ArrayBuffer(base + 16);
  new Uint8Array(packet).set([87, 80, 82, 49]);
  new DataView(packet).setUint32(4, text.length, true);
  new Uint8Array(packet, 8, text.length).set(text);
  new Float32Array(packet, base, 2).set([1, 2]);
  new BigInt64Array(packet, base + 8, 1)[0] = 2n ** 54n + 1n;
  const frame = decodeFrame(packet);
  assert.equal(frame.index, 2);
  assert.deepEqual([...frame.arrays.positions.data], [1, 2]);
  assert.equal(frame.arrays.UIDs.data[0], 2n ** 54n + 1n);
  assert.throws(() => decodeFrame(packet.slice(0, base + 9)), /Invalid array/);
});

test("diagnostic history preserves unloaded and invalid gaps", () => {
  const rows = [
    {
      index: 0,
      time: 0,
      particles: 2,
      kineticEnergy: 0,
      maxSpeed: 1,
      meanDensity: 1,
    },
    {
      index: 2,
      time: 2,
      particles: 2,
      kineticEnergy: null,
      maxSpeed: 2,
      meanDensity: 1,
    },
    {
      index: 3,
      time: 3,
      particles: 2,
      kineticEnergy: 4,
      maxSpeed: 3,
      meanDensity: 1,
    },
  ];
  assert.deepEqual(diagnosticSeries([0, 1, 2, 3], rows, "kineticEnergy"), [
    0,
    null,
    null,
    4,
  ]);
});
