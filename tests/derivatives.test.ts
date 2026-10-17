import test from "node:test";
import assert from "node:assert/strict";
import {
  reconstructGrid,
  initialGrid,
  matchesFieldResult,
  type FieldResult,
} from "../web/src/sources/grid";
import {
  fixture,
  velocityFixture,
  velocityDomain,
} from "../web/src/compute/fixtures";
import type { RawFrame } from "../web/src/sources/core";
const settings = { ...initialGrid, resolution: 128 as const };

test("normalized analytic derivatives preserve uniform translation and recover affine divergence/curl in the interior", () => {
  for (const kernel of ["wendland2", "wendland4"] as const) {
    for (const [name, velocity, div, curl, tolerance] of [
      ["translation", () => [1e6, -2e6], 0, 0, 1e-8],
      ["expansion", (x: number, y: number) => [2 * x, 3 * y], 5, 0, 0.015],
      ["rotation", (x: number, y: number) => [-2 * y, 2 * x], 0, 4, 0.015],
      ["shear", (_x: number, y: number) => [y, 0], 0, -1, 0.015],
    ] as const) {
      const raw = velocityFixture(velocity);
      for (const [quantity, expected] of [
        ["divergence", div],
        ["vorticity", curl],
      ] as const) {
        const grid = reconstructGrid(
          raw,
          velocityDomain,
          "velocities",
          "magnitude",
          { ...settings, kernel, quantity },
        );
        for (let y = 40; y < 88; y++)
          for (let x = 40; x < 88; x++)
            assert.ok(
              Math.abs(grid.values[y * grid.width + x] - expected) < tolerance,
              `${name} ${kernel} ${quantity}: ${grid.values[y * grid.width + x]} != ${expected}`,
            );
      }
    }
  }
});

/** Independent point-query interpolation used only as a finite-difference oracle. */
function sample(raw: RawFrame, point: number[], kernel: string) {
  let w = 0,
    u = 0,
    v = 0;
  for (let j = 0; j < raw.positions.shape[0]; j++) {
    if (Number(raw.kinds.data[j]) !== 0) continue;
    const h = Number(raw.supports.data[j]);
    let x = point[0] - Number(raw.positions.data[2 * j]),
      y = point[1] - Number(raw.positions.data[2 * j + 1]);
    x -= Math.round(x);
    y -= Math.round(y);
    const q = Math.hypot(x, y) / h;
    if (q >= 1) continue;
    const weight =
      (Number(raw.masses.data[j]) /
        Number(raw.densities.data[j]) /
        (Math.PI * h * h)) *
      (kernel === "wendland2"
        ? 7 * (1 - q) ** 4 * (1 + 4 * q)
        : 9 * (1 - q) ** 6 * (1 + 6 * q + (35 / 3) * q * q));
    w += weight;
    u += weight * Number(raw.velocities.data[2 * j]);
    v += weight * Number(raw.velocities.data[2 * j + 1]);
  }
  return [u / w, v / w];
}
test("quotient-rule derivatives agree with independent point finite differences for irregular periodic variable-support particles", () => {
  const raw = fixture(),
    domain = { domain: { min: [0, 0], max: [1, 1], periodic: [true, true] } };
  for (const kernel of ["wendland2", "wendland4"] as const) {
    const div = reconstructGrid(raw, domain, "velocities", "magnitude", {
      ...settings,
      kernel,
      quantity: "divergence",
    });
    const curl = reconstructGrid(raw, domain, "velocities", "magnitude", {
      ...settings,
      kernel,
      quantity: "vorticity",
    });
    for (const [x, y] of [
      [0, 0],
      [127, 127],
      [64, 32],
      [17, 94],
      [1, 127],
    ]) {
      const p = [(x + 0.5) / 128, (y + 0.5) / 128],
        e = 1e-5,
        xp = sample(raw, [p[0] + e, p[1]], kernel),
        xm = sample(raw, [p[0] - e, p[1]], kernel),
        yp = sample(raw, [p[0], p[1] + e], kernel),
        ym = sample(raw, [p[0], p[1] - e], kernel);
      const expectedDiv = (xp[0] - xm[0] + yp[1] - ym[1]) / (2 * e),
        expectedCurl = (xp[1] - xm[1] - yp[0] + ym[0]) / (2 * e),
        i = y * 128 + x;
      assert.ok(Math.abs(div.values[i] - expectedDiv) < 2e-5);
      assert.ok(Math.abs(curl.values[i] - expectedCurl) < 2e-5);
    }
  }
});
test("derivatives depend on valid recorded velocity, exclude boundaries, and keep dry/invalid cells masked", () => {
  const raw = velocityFixture(() => [3, 4]);
  raw.velocities.data[2 * 600] = NaN;
  raw.kinds.data[0] = 1;
  raw.velocities.data[0] = NaN;
  const grid = reconstructGrid(raw, velocityDomain, "velocities", "magnitude", {
    ...settings,
    quantity: "vorticity",
  });
  assert.ok(grid.values.some(Number.isFinite));
  assert.ok(grid.values.some(Number.isNaN));
  for (let i = 0; i < grid.values.length; i++)
    assert.equal(Number.isFinite(grid.values[i]), !!grid.velocityValid[i]);
  delete raw.velocities;
  assert.throws(
    () =>
      reconstructGrid(raw, velocityDomain, "densities", "magnitude", {
        ...settings,
        quantity: "divergence",
      }),
    /recorded.*velocity/,
  );
});
test("derived grids and velocity-only streamline overlays match only their own source/frame, independent of particle coloring", () => {
  const result = {
    sourceId: "s",
    field: "velocities",
    mapping: "magnitude",
    grid: { index: 2, quantity: "vorticity" },
  } as FieldResult;
  assert.equal(matchesFieldResult(result, "s", 2, "UIDs", "x", "both"), true);
  assert.equal(
    matchesFieldResult(result, "other", 2, "UIDs", "x", "both"),
    false,
  );
  assert.equal(matchesFieldResult(result, "s", 3, "UIDs", "x", "both"), false);
  assert.equal(
    matchesFieldResult(
      { ...result, field: "densities" },
      "s",
      2,
      "densities",
      "magnitude",
      "grid",
    ),
    false,
  );
  const flow = {
    ...result,
    grid: { ...result.grid, quantity: "field" as const },
  };
  assert.equal(
    matchesFieldResult(flow, "s", 2, "UIDs", "x", "particles"),
    true,
  );
  assert.equal(matchesFieldResult(flow, "s", 2, "UIDs", "x", "grid"), false);
});
