import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  rememberFiles,
  recallFiles,
  forgetFiles,
  fileKey,
  saveView,
  recallView,
  sanitizeView,
} from "../web/src/session";
import { initialOptions } from "../web/src/types";
import { initialGrid } from "../web/src/sources/grid";
test("remembered local files survive a fresh read, preserve bytes/names, replace atomically and can be forgotten", async () => {
  await forgetFiles();
  assert.equal(await recallFiles(), null);
  const original = [
    new File([new Uint8Array([1, 2, 255])], "recording.h5", {
      lastModified: 17,
    }),
    new File(["{}"], "metadata.json", { lastModified: 18 }),
  ];
  await rememberFiles(original);
  const saved = await recallFiles();
  assert.equal(saved?.key, fileKey(original));
  assert.deepEqual(await saved!.files[0].bytes(), new Uint8Array([1, 2, 255]));
  assert.equal(saved!.files[0].lastModified, 17);
  const replacement = [new File(["new"], "other.npz", { lastModified: 21 })];
  await rememberFiles(replacement);
  const next = await recallFiles();
  assert.equal(next!.files.length, 1);
  assert.equal(next!.files[0].name, "other.npz");
  assert.equal(await next!.files[0].text(), "new");
  await forgetFiles();
  assert.equal(await recallFiles(), null);
});
test("saved visualization settings round-trip with the recording and forget together", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    const view = {
      key: "khh",
      index: 80,
      field: "densities",
      options: {
        ...initialOptions,
        palette: "magma",
        normalization: "symlog" as const,
        range: "fixed" as const,
        min: 1,
        max: 2.2,
        size: 1.5,
        background: "light" as const,
      },
      fieldView: {
        mode: "both" as const,
        flow: true,
        settings: {
          ...initialGrid,
          backend: "cpu" as const,
          quantity: "vorticity" as const,
          resolution: 128 as const,
          minCoverage: 0.3,
        },
        seeds: 5,
        seedMode: "picked" as const,
        seed: [0.2, -0.1],
      },
      playback: { speed: 2, loop: false },
      metric: "totalEnergy" as const,
    };
    saveView(view);
    assert.deepEqual(recallView("khh"), view);
    assert.equal(recallView("different-recording"), null);
    await forgetFiles();
    assert.equal(recallView("khh"), null);
    values.set("warpsph-last-view", "corrupt{");
    assert.equal(recallView("khh"), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("old saved views remain usable; corrupt, unsupported and nonfinite settings get safe defaults", () => {
  const legacy = sanitizeView(
    { key: "old", index: 10, field: "pressures" },
    "old",
  );
  assert.equal(legacy!.index, 10);
  assert.equal(legacy!.options, undefined);
  const view = sanitizeView(
    {
      key: "file",
      index: -10,
      options: {
        palette: "missing",
        min: NaN,
        max: Infinity,
        size: -5,
        range: "fixed",
        normalization: "log",
      },
      fieldView: {
        mode: "unsupported",
        seeds: 1000,
        settings: { resolution: 8192, minCoverage: NaN, quantity: "FTLE" },
        seedMode: "picked",
        seed: [NaN, 1],
      },
    },
    "file",
  )!;
  assert.equal(view.index, 0);
  assert.equal(view.options!.palette, "viridis");
  assert.equal(view.options!.range, "frame");
  assert.equal(view.options!.size, 1);
  assert.equal(view.fieldView!.settings.resolution, 256);
  assert.equal(view.fieldView!.settings.backend, "auto");
  assert.equal(view.fieldView!.settings.quantity, "field");
  assert.equal(view.fieldView!.seeds, 8);
  assert.equal(view.fieldView!.seedMode, "regular");
});
