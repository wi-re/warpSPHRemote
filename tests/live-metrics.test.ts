import { test } from "node:test";
import assert from "node:assert/strict";
import {
  remainingSeconds,
  transferRate,
  pipelinePresentation,
} from "../web/src/liveMetrics";
import type { Simulation } from "../web/src/companion";

test("ETA uses active throughput and the solver's stopping criterion", () => {
  const run = {
    status: "running",
    stale: false,
    step: 20,
    time: 2,
    performance: { stepMs: 50, simulationRate: 0.5, targetTime: 10 },
  } as Simulation;
  assert.equal(remainingSeconds(run), 16);
  assert.equal(remainingSeconds({ ...run, status: "paused" }), 16);
  assert.equal(remainingSeconds({ ...run, stale: true }), undefined);
  assert.equal(remainingSeconds({ ...run, status: "completed" }), undefined);
  assert.equal(
    remainingSeconds({
      ...run,
      performance: { ...run.performance, targetStep: 120 },
    }),
    5,
  );
  assert.equal(
    remainingSeconds({
      ...run,
      performance: { simulationRate: 0, targetTime: 10 },
    }),
    undefined,
  );
  assert.equal(remainingSeconds({ ...run, time: 11 }), 0);
  assert.equal(
    transferRate({
      bytes: 10e6,
      staticBytes: 0,
      durationMs: 200,
      receivedAt: 0,
      totalBytes: 10e6,
    }),
    50,
  );
});

test("missing stages identify an old daemon, old worker, and pending status separately", () => {
  const run = { status: "running", registered: true } as Simulation;
  const oldDaemon = pipelinePresentation(run, false);
  assert.equal(oldDaemon.capture, "Companion restart needed");
  assert.match(oldDaemon.note!, /finish the current recording first/);
  assert.equal(
    pipelinePresentation(run, true).capture,
    "Older simulation adapter",
  );
  assert.equal(
    pipelinePresentation({ ...run, status: "starting" }, true).capture,
    "Waiting for adapter status",
  );
  assert.equal(
    pipelinePresentation({ ...run, capabilities: ["captureDiagnostics"] }, true)
      .capture,
    "Waiting for adapter status",
  );
  assert.equal(
    pipelinePresentation({ ...run, capabilities: ["stepVideo"] }, true).note,
    undefined,
  );
  const current = pipelinePresentation(
    {
      ...run,
      pipeline: {
        solver: "video_frame",
        capture: "encoding",
        solverSeconds: 2,
      },
    },
    true,
  );
  assert.match(current.solver, /acknowledgement/);
  assert.equal(current.capture, "Encoding frame on adapter");
  assert.equal(
    pipelinePresentation({ ...run, status: "completed" }, true).capture,
    "Finished",
  );
});

test("legacy daemon rendering explains restart without presenting missing metadata as a stall", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveMetrics } = await import("../web/src/LiveMetrics");
  const run = {
    id: "legacy-run",
    status: "running",
    registered: true,
    startedAt: 0,
    updatedAt: 0,
  } as Simulation;
  const html = renderToStaticMarkup(
    createElement(LiveMetrics, {
      control: {
        sourceId: "live-legacy-run",
        run,
        status: "running",
        pauseRequested: false,
        canPause: true,
        busy: false,
        toggle: () => {},
        captureDiagnosticsSupported: false,
      },
    }),
  );
  assert.match(html, /Companion restart needed/);
  assert.match(html, /finish the current recording first/);
  assert.doesNotMatch(html, /Adapter stage unavailable/);
});
