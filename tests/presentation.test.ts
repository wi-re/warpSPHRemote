import test from "node:test";
import assert from "node:assert/strict";
import { loadPresentation } from "../web/src/sources/presentation";
import {
  initialGrid,
  type FieldQuery,
  type FieldResult,
} from "../web/src/sources/grid";
import type { Frame } from "../web/src/types";

const frame = { index: 7 } as Frame;
const result = { grid: { index: 7 }, sourceId: "recording" } as FieldResult;
const query: FieldQuery = {
  index: 7,
  field: "densities",
  mapping: "magnitude",
  settings: initialGrid,
  streams: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test("grid playback publishes a frame only after the matching reconstruction completes", async () => {
  const f = deferred<Frame>(),
    g = deferred<FieldResult>(),
    calls: string[] = [];
  const reader = {
    metadata: { id: "recording" },
    frame: async () => {
      calls.push("frame");
      return f.promise;
    },
    grid: async () => {
      calls.push("grid");
      return g.promise;
    },
  } as Parameters<typeof loadPresentation>[0];
  let committed = false;
  const pending = loadPresentation(
    reader,
    7,
    "densities",
    "grid",
    query,
    "seven",
    new AbortController().signal,
  ).then((p) => {
    committed = true;
    return p;
  });
  assert.deepEqual(calls, ["frame", "grid"]); // no intervening background history job
  f.resolve(frame);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(committed, false); // particle-only preview must never escape
  g.resolve(result);
  const presentation = await pending;
  assert.equal(presentation.mode, "grid");
  assert.equal(presentation.frame.index, presentation.result!.grid.index);
  assert.equal(presentation.key, "seven");
});
test("scrubbing cannot commit a late reconstruction after the target was cancelled", async () => {
  const g = deferred<FieldResult>(),
    abort = new AbortController();
  const reader = {
    metadata: { id: "recording" },
    frame: async () => frame,
    grid: () => g.promise,
  } as Parameters<typeof loadPresentation>[0];
  const pending = loadPresentation(
    reader,
    7,
    "densities",
    "grid",
    query,
    "old-target",
    abort.signal,
  );
  abort.abort();
  g.resolve(result);
  await assert.rejects(pending, { name: "AbortError" });
});
test("particle-only playback and categorical grid requests stay interactive without interpolation", async () => {
  let grids = 0,
    frames = 0;
  const reader = {
    metadata: { id: "recording" },
    frame: async () => {
      frames++;
      return frame;
    },
    grid: async () => {
      grids++;
      return result;
    },
  } as Parameters<typeof loadPresentation>[0];
  const p = await loadPresentation(
    reader,
    7,
    "densities",
    "particles",
    null,
    "particles",
    new AbortController().signal,
  );
  assert.equal(p.result, null);
  assert.equal(grids, 0);
  const categorical = await loadPresentation(
    reader,
    7,
    "UIDs",
    "grid",
    { ...query, field: "UIDs" },
    "ids",
    new AbortController().signal,
  );
  assert.equal(categorical.mode, "particles");
  assert.equal(categorical.result, null);
  assert.equal(grids, 0);
  assert.equal(frames, 2);
});

test("a derived velocity grid can accompany categorical particle coloring without changing its source/frame contract", async () => {
  let requested = "";
  const derived = {
    ...query,
    field: "velocities",
    settings: { ...initialGrid, quantity: "vorticity" as const },
  };
  const reader = {
    metadata: { id: "recording" },
    frame: async (_i: number, f: string) => {
      requested = f;
      return frame;
    },
    grid: async () => result,
  };
  const p = await loadPresentation(
    reader,
    7,
    "UIDs",
    "both",
    derived,
    "derived",
    new AbortController().signal,
  );
  assert.equal(requested, "UIDs");
  assert.equal(p.field, "UIDs");
  assert.equal(p.result, result);
});

test("picked streamlines wait without blocking the field or LIC, then resume with a selected seed", async () => {
  const requests: FieldQuery[] = [];
  const reader = {
    metadata: { id: "recording" },
    frame: async () => frame,
    grid: async (request: FieldQuery) => {
      requests.push(request);
      return result;
    },
  };
  const picked: FieldQuery = {
    ...query,
    streams: { seeds: 8, steps: 400 },
    seed: [],
    lic: { steps: 16, contrast: 1.8, seed: 1 },
  };
  const show = (request: FieldQuery) =>
    loadPresentation(
      reader,
      7,
      "densities",
      "grid",
      request,
      JSON.stringify(request),
      new AbortController().signal,
    );
  const waiting = await show(picked);
  assert.equal(waiting.frame, frame);
  assert.equal(waiting.result, result);
  assert.equal(waiting.mode, "grid");
  assert.equal(requests[0].streams, null);
  assert.equal(requests[0].seed, undefined);
  assert.deepEqual(requests[0].lic, picked.lic);
  assert.deepEqual(picked.seed, []); // retain the user's pending picked-seed mode
  await show({ ...picked, seed: [0.25, 0.5] });
  assert.deepEqual(requests[1].seed, [0.25, 0.5]);
  assert.deepEqual(requests[1].streams, picked.streams);
  await show({ ...picked, seed: undefined });
  assert.deepEqual(requests[2].streams, picked.streams); // regular seeds still work
});

test("a reconstruction failure preserves the numerical frame and provides a recoverable warning", async () => {
  const reader = {
    metadata: { id: "recording" },
    frame: async () => frame,
    grid: async () => {
      throw new Error("Device buffer limit");
    },
  };
  const p = await loadPresentation(
    reader,
    7,
    "densities",
    "grid",
    query,
    "failed-grid",
    new AbortController().signal,
  );
  assert.equal(p.frame, frame);
  assert.equal(p.mode, "particles");
  assert.equal(p.result, null);
  assert.equal(p.warning, "Device buffer limit");
});

test("cancelled reconstruction failures cannot turn into particle fallback updates", async () => {
  const abort = new AbortController();
  const reader = {
    metadata: { id: "recording" },
    frame: async () => frame,
    grid: async () => {
      abort.abort();
      throw new Error("cancelled work");
    },
  };
  await assert.rejects(
    loadPresentation(
      reader,
      7,
      "densities",
      "grid",
      query,
      "cancelled-grid",
      abort.signal,
    ),
    { name: "AbortError" },
  );
});
