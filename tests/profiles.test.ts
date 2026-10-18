import { test } from "node:test";
import assert from "node:assert/strict";
import { profile, newProfile } from "../web/src/profiles";
import type { Frame } from "../web/src/types";
function fixture(): Frame {
  return {
    index: 0,
    time: 0,
    bytes: 0,
    arrays: {
      positions: {
        data: new Float32Array([1, 0, 0, 1, -1, 0, 0, -1, 0, 0]),
        shape: [5, 2],
      },
      velocities: {
        data: new Float32Array([0, 2, -2, 0, 0, -2, 2, 0, 1, 0]),
        shape: [5, 2],
      },
      densities: { data: new Float32Array([1, 2, 4, 8, 16]), shape: [5] },
      masses: { data: new Float32Array([1, 2, 4, 8, 16]), shape: [5] },
      kinds: { data: new Int32Array([0, 0, 0, 1, 0]), shape: [5] },
      UIDs: {
        data: new BigInt64Array([9007199254740993n, 2n, 3n, 4n, 5n]),
        shape: [5],
      },
    },
  };
}
test("radial scatter preserves particles and exact identities; signed tangential projection differs from magnitude", () => {
  const s = {
    ...newProfile("velocities"),
    coordinate: "radius" as const,
    component: "tangential" as const,
  };
  const r = profile(fixture(), s);
  assert.deepEqual(r.x, [1, 1, 1]);
  assert.deepEqual(r.y, [2, 2, 2]);
  assert.equal(r.omitted, 1);
  assert.equal(r.uid[0], "9007199254740993");
  const radial = profile(fixture(), { ...s, component: "radial" });
  assert.deepEqual(radial.y, [0, 0, 0]);
  assert.deepEqual(
    profile(fixture(), { ...s, component: "magnitude" }).y,
    [2, 2, 2, 1],
  );
});
test("binned profiles use count/mass/volume weighting and population standard deviation", () => {
  const f = fixture();
  const s = {
    ...newProfile("densities"),
    coordinate: "radius" as const,
    mode: "binned" as const,
    bins: 2,
    sliceAxis: 0,
    sliceMin: -1,
    sliceMax: 1,
  };
  const r = profile(f, s);
  assert.deepEqual(r.counts, [1, 3]);
  assert.ok(Math.abs(r.y[1] - 7 / 3) < 1e-12);
  const mass = profile(f, { ...s, weight: "mass" });
  assert.equal(mass.y[1], 3);
  const volume = profile(f, { ...s, weight: "volume" });
  assert.ok(Math.abs(volume.y[1] - 7 / 3) < 1e-12);
  assert.ok(Math.abs(r.spread[1] - Math.sqrt(14 / 9)) < 1e-10);
});
test("profiles handle wrapping, clipping, empty sets, log masks and bounded sampling", () => {
  const f = fixture();
  f.arrays.positions.data[0] = 3;
  const domain = { min: [-1, -1], max: [1, 1], periodic: [true, false] };
  const s = newProfile("densities");
  assert.equal(profile(f, s, domain).x[0], -1);
  assert.equal(profile(f, { ...s, wrap: false }, domain).x[0], 3);
  assert.equal(profile(f, { ...s, selection: "kind", kind: 99 }).accepted, 0);
  assert.deepEqual(profile(f, { ...s, xlog: true }, undefined).x, [3]);
  assert.ok(profile(f, s, undefined, 2).x.length <= 2);
  assert.throws(() => profile(f, { ...s, coordinate: "z" }), /3D/);
  assert.throws(() => profile(f, { ...s, component: "radial" }), /vector/);
});
test("angular sectors cross the atan2 seam explicitly and material filters preserve row identity", () => {
  const f = fixture();
  f.arrays.materials = { data: new Int32Array([1, 2, 1, 2, 1]), shape: [5] };
  const settings = {
    ...newProfile("densities"),
    selection: "material" as const,
    materialField: "materials",
    material: 1,
    sector: true,
    angleMin: 2,
    angleMax: -2,
  };
  const r = profile(f, settings);
  assert.deepEqual(r.uid, ["3"]);
  assert.deepEqual(r.x, [-1]);
  assert.throws(
    () => profile(f, { ...settings, materialField: "missing" }),
    /material field/,
  );
});
