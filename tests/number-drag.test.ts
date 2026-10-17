import test from "node:test";
import assert from "node:assert/strict";
import { dragNumber } from "../web/src/numberDrag";
import {
  validGridResolution,
  reconstructGrid,
  initialGrid,
} from "../web/src/sources/grid";
import { parseViewLink } from "../web/src/viewPresets";
import { sanitizeView } from "../web/src/session";
import { fixture } from "../web/src/compute/fixtures";

test("number drag has directional control, speed/distance acceleration, precision and bounds", () => {
  const slow = dragNumber(100, -20, 0, 500, 1);
  const fast = dragNumber(100, -20, 0, 20, 1);
  const wide = dragNumber(100, -20, 210, 500, 1);
  assert.ok(slow.value > 100);
  assert.ok(fast.value > slow.value);
  assert.ok(wide.value > slow.value);
  assert.ok(dragNumber(100, 20, 0, 500, 1).value < 100);
  assert.ok(
    dragNumber(100, -20, 210, 500, 1, -Infinity, Infinity, true).value <
      wide.value,
  );
  assert.equal(dragNumber(100, -100, 500, 1, 1, 0, 120).value, 120);
  assert.equal(dragNumber(0, 100, 500, 1, 0.01, 0, 1).value, 0);
  assert.equal(dragNumber(100, 0, 500, 1, 1).value, 100);
});

test("custom grid sizes reconstruct and survive settings/URLs without rounding to a preset", () => {
  const source = {
    domain: { min: [0, 0], max: [1, 1], periodic: [true, true] },
  };
  const grid = reconstructGrid(fixture(), source, "test", "magnitude", {
    ...initialGrid,
    resolution: 173,
  });
  assert.equal(grid.width, 173);
  assert.equal(grid.height, 173);
  assert.ok(grid.values.some(Number.isFinite));
  assert.equal(parseViewLink("?resolution=173").view.settings?.resolution, 173);
  assert.equal(
    sanitizeView(
      {
        key: "custom",
        fieldView: { resolution: 173, settings: { resolution: 173 } },
      },
      "custom",
    )?.fieldView?.settings.resolution,
    173,
  );
  for (const size of [7, 2049, 128.5, Infinity, NaN])
    assert.equal(validGridResolution(size), false);
  assert.throws(
    () =>
      reconstructGrid(fixture(), source, "test", "magnitude", {
        ...initialGrid,
        resolution: 2049,
      }),
    /Invalid grid settings/,
  );
});
