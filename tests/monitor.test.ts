import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverSimulations,
  activeSimulation,
  recallMonitor,
  rememberMonitor,
} from "../web/src/monitor";
import type { Simulation } from "../web/src/companion";
const run = (
  id: string,
  startedAt: number,
  extra: Partial<Simulation> = {},
): Simulation => ({
  id,
  name: id,
  startedAt,
  updatedAt: startedAt,
  status: "running",
  registered: true,
  visualized: false,
  stale: false,
  sequence: 0,
  createdBy: "simulation",
  ...extra,
});
test("monitor mode is opt-in; enabling it follows the newest active run on connection", () => {
  const runs = [
    run("newer", 3),
    run("ended", 4, { status: "completed" }),
    run("older", 1),
  ];
  assert.equal(discoverSimulations(runs, null, false).follow, undefined);
  assert.equal(discoverSimulations(runs, null, false).notice, undefined);
  assert.equal(discoverSimulations(runs, null, true).follow?.id, "newer");
  assert(!activeSimulation(run("stale", 8, { stale: true })));
});
test("new launches are followed once, even when registration arrives on a later poll", () => {
  const baseline = discoverSimulations([run("old", 1)], null, true);
  const starting = run("external", 2, {
    status: "starting",
    registered: false,
  });
  const fresh = discoverSimulations(
    [run("old", 1), starting],
    baseline.known,
    true,
  );
  assert.equal(fresh.follow, starting); // queue the run; attachment waits for registration
  assert.equal(fresh.notice, starting);
  const ready = { ...starting, registered: true };
  assert.equal(
    discoverSimulations([ready], fresh.known, true).follow,
    undefined,
  );
  assert.equal(
    discoverSimulations([ready], fresh.known, true).notice,
    undefined,
  );
});
test("discovery uses launch time rather than list order and never reattaches after a manual detach", () => {
  const known = new Set(["old"]);
  const fresh = discoverSimulations(
    [run("latest", 9), run("next", 4), run("old", 1)],
    known,
    true,
  );
  assert.equal(fresh.follow?.id, "latest");
  assert.equal(
    discoverSimulations([run("latest", 9)], fresh.known, true).follow,
    undefined,
  );
  assert.equal(
    discoverSimulations([run("off", 10)], fresh.known, false).follow,
    undefined,
  );
  assert.equal(
    discoverSimulations(
      [run("failed", 11, { status: "failed" })],
      fresh.known,
      true,
    ).follow,
    undefined,
  );
});
test("monitor preference persists independently of pairing and defaults off when storage is unavailable", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    assert.equal(recallMonitor(), false);
    rememberMonitor(true);
    assert.equal(recallMonitor(), true);
    rememberMonitor(false);
    assert.equal(recallMonitor(), false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw Error("blocked");
      },
    });
    assert.equal(recallMonitor(), false);
    assert.doesNotThrow(() => rememberMonitor(true));
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
