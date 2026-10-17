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
test("particle-only playback never requests reconstruction, and invalid grid choices fail explicitly", async () => {
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
  await assert.rejects(
    loadPresentation(
      reader,
      7,
      "UIDs",
      "grid",
      { ...query, field: "UIDs" },
      "invalid",
      new AbortController().signal,
    ),
    /continuous/,
  );
  assert.equal(frames, 1);
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
