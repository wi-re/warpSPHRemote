import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingSeconds, transferRate } from "../web/src/liveMetrics";
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
