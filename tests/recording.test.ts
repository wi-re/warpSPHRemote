import test from "node:test";
import assert from "node:assert/strict";
import {
  captureCount,
  videoPlan,
  videoPlanText,
  validCadence,
  saveRecordingView,
  readRecordingView,
} from "../web/src/recording";
import { initialOptions } from "../web/src/types";
import { initialGrid } from "../web/src/sources/grid";
import { limitingStage } from "../web/src/liveMetrics";

test("capture counts include initial and off-cadence final frames without duplicating exact endpoints", () => {
  assert.equal(captureCount(0, 1, 0.1), 11);
  assert.equal(captureCount(0, 1, 0.3), 5);
  assert.equal(captureCount(20, 40, 3), 8);
  assert.equal(captureCount(5, 5, 10), 1);
  assert.equal(captureCount(4, 2, 1), undefined);
  assert.deepEqual(videoPlan(25, 0, 1, 0.1), {
    frames: 11,
    seconds: 0.44,
    estimated: false,
  });
  assert.match(
    videoPlanText(videoPlan(30, 0, undefined, 5, true)),
    /need a known/,
  );
  assert.equal(validCadence(30, 0.04, 0), false);
  assert.equal(validCadence(30, 0.04, 2.5), false);
});

test("recording preset is an owned copy and survives reopening with camera and reconstruction settings", () => {
  const store = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  });
  try {
    const value: any = {
      version: 1,
      sourceId: "live-run",
      field: "densities",
      options: { ...initialOptions },
      fieldView: {
        mode: "grid",
        flow: false,
        settings: { ...initialGrid },
        seeds: 8,
        seedMode: "regular",
      },
      viewport: {
        kind: "particles",
        position: [1, 2, 3],
        target: [0, 0, 0],
        up: [0, 1, 0],
        top: 2,
        bottom: -2,
        zoom: 2,
        near: 0.01,
        far: 100,
      },
      time: 0,
    };
    const saved = saveRecordingView(value);
    value.options.palette = "plasma";
    value.viewport.position[0] = 99;
    assert.notEqual(saved.options.palette, "plasma");
    assert.equal(saved.viewport.kind, "particles");
    assert.deepEqual(readRecordingView("live-run"), saved);
    assert.equal(readRecordingView("other-run"), null);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previous,
    });
  }
});

test("pipeline explanation distinguishes user pauses, viewer waits and background transfer", () => {
  const run: any = {
    status: "running",
    pipeline: { solver: "running" },
    performance: { captureMs: 2, encodeMs: 5 },
    video: { active: false },
  };
  const transfer: any = { durationMs: 1600 };
  assert.match(
    limitingStage(run, transfer, 50, 4),
    /frame download.*does not hold the solver/,
  );
  run.pipeline.solver = "video_viewer";
  assert.match(limitingStage(run, transfer), /until a viewer reconnects/);
  run.pipeline.solver = "paused";
  assert.match(limitingStage(run, transfer), /paused/);
});
