import test from "node:test";
import assert from "node:assert/strict";
import {
  samplePressures,
  clickedFrame,
  type PressureProbe,
} from "../web/src/sources/probes";
import type { RawFrame } from "../web/src/sources/core";
const frame: RawFrame = {
  positions: {
    data: new Float64Array([0, 0, 2, 0, 1, 0, 1, 0]),
    shape: [4, 2],
  },
  pressures: { data: new Float64Array([10, 30, 999, NaN]), shape: [4] },
  kinds: { data: new Int32Array([0, 0, 1, 0]), shape: [4] },
};
const probe: PressureProbe = {
  id: "p",
  name: "p",
  position: [1, 0],
  radius: 2,
  method: "idw",
};
test("fixed pressure probes reconstruct finite fluid neighbours, excluding boundary and invalid values", () => {
  assert.equal(samplePressures(frame, [probe]).p, 20);
  assert.ok(
    Math.abs(
      samplePressures(frame, [{ ...probe, position: [0.5, 0] }]).p! - 12,
    ) < 1e-12,
  );
  assert.equal(samplePressures(frame, [{ ...probe, position: [0, 0] }]).p, 10);
  assert.equal(
    samplePressures(frame, [
      { ...probe, position: [1.5, 0], method: "nearest" },
    ]).p,
    30,
  );
});
test("dry probes, missing pressure, invalid coordinates and incompatible fields leave gaps", () => {
  assert.equal(samplePressures(frame, [{ ...probe, radius: 0.1 }]).p, null);
  assert.equal(
    samplePressures({ positions: frame.positions }, [probe]).p,
    null,
  );
  assert.equal(
    samplePressures(frame, [{ ...probe, position: [NaN, 0] }]).p,
    null,
  );
  assert.equal(
    samplePressures(frame, [{ ...probe, position: [0, 0, 0] }]).p,
    null,
  );
  assert.equal(samplePressures(frame, [{ ...probe, radius: 0 }]).p, null);
});
test("probe curves use exact frame indices instead of assuming regular sampling times", () => {
  assert.equal(clickedFrame({ points: [{ customdata: 4 }] }, 8), 4);
  for (const value of [undefined, null, -1, 8, 2.5, "4", NaN])
    assert.equal(clickedFrame({ points: [{ customdata: value }] }, 8), null);
});
