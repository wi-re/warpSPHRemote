import test from "node:test";
import assert from "node:assert/strict";
import { periodicColorValue } from "../web/src/periodicColor";
import { parseViewLink, colorPresets } from "../web/src/viewPresets";
import { sanitizeView } from "../web/src/session";
import { loadPresentation } from "../web/src/sources/presentation";
import { initialGrid } from "../web/src/sources/grid";
import type { Frame } from "../web/src/types";

test("periodic UID colors repeat without losing exact large integer identities", () => {
  const huge = 2n ** 62n + 19n;
  assert.equal(periodicColorValue(huge, 256), 19);
  assert.equal(periodicColorValue(huge + 256n, 256), 19);
  assert.equal(periodicColorValue(-1n, 256), 255);
  assert.equal(periodicColorValue(513, 256), 1);
  const link = parseViewLink("?colorPreset=uid-cyclic");
  assert.equal(link.field, "UIDs");
  assert.equal(link.options.normalization, "cyclic");
  assert.equal(link.options.palette, "twilight");
  assert.equal(link.options.colorPeriod, 256);
  assert.ok(colorPresets.some((p) => p.id === "uid-cyclic"));
  assert.equal(
    sanitizeView(
      { key: "ids", options: { normalization: "cyclic", colorPeriod: 1024 } },
      "ids",
    )?.options?.colorPeriod,
    1024,
  );
});

test("categorical particle colors can retain continuous velocity streamlines without scalar interpolation", async () => {
  let field = "";
  const reader = {
    metadata: { id: "recording" },
    frame: async () => ({ index: 0 }) as Frame,
    grid: async (q: any) => {
      field = q.field;
      assert.equal(q.lic, undefined);
      return { grid: { index: 0 } } as any;
    },
  };
  const p = await loadPresentation(
    reader,
    0,
    "UIDs",
    "grid",
    {
      index: 0,
      field: "UIDs",
      mapping: "magnitude",
      settings: initialGrid,
      streams: { seeds: 8, steps: 400 },
    },
    "ids",
    new AbortController().signal,
  );
  assert.equal(p.mode, "particles");
  assert.equal(p.field, "UIDs");
  assert.equal(field, "velocities");
});
