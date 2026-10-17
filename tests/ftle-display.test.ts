import test from "node:test";
import assert from "node:assert/strict";
import { ftleSummary } from "../web/src/ftleDisplay";
import type { FTLEBatch } from "../web/src/sources/ftle";

test("FTLE coverage distinguishes rejected fits from zero stretching and unfinished cells", () => {
  const result: FTLEBatch = {
    width: 4,
    height: 2,
    offset: 7,
    bounds: [
      [0, 0],
      [1, 1],
    ],
    values: Float32Array.from([0, 2, NaN, NaN, NaN, NaN, NaN, NaN]),
    residual: Float32Array.from([0, 0.1, NaN, NaN, 0.5, 0.1, NaN, NaN]),
    counts: Uint8Array.from([24, 24, 0, 2, 24, 24, 24, 0]),
    condition: new Float32Array(8),
    uids: ["1", "2", null, "3", "4", "5", "6", null],
  };
  const s = ftleSummary(result, 0.25);
  assert.equal(s.valid, 2);
  assert.equal(s.masked, 5);
  assert.equal(s.pending, 1);
  assert.equal(s.noParticle, 1);
  assert.equal(s.fewMatches, 1);
  assert.equal(s.residual, 1);
  assert.equal(s.unavailable, 2);
  assert.equal(s.min, 0);
  assert.equal(s.max, 2);
  assert.equal(s.valid + s.masked + s.pending, s.total);
});
