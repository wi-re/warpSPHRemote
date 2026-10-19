import test from "node:test";
import assert from "node:assert/strict";
import { canForgetRun, clearFinishedHistory } from "../web/src/runHistory";
import type { Simulation } from "../web/src/companion";
const run = (id: string, status: string, registered = false) =>
  ({ id, status, registered }) as Simulation;
test("bulk history clearing includes finished runs and leaves active/recovering producers alone", async () => {
  const runs = [
    run("a", "completed"),
    run("b", "failed"),
    run("c", "stopped"),
    run("d", "interrupted"),
    run("e", "running"),
    run("f", "starting"),
    run("g", "paused"),
    run("h", "interrupted", true),
  ];
  const deleted: string[] = [],
    progress: unknown[] = [];
  assert.equal(canForgetRun(runs[7]), false);
  assert.equal(
    await clearFinishedHistory(
      runs,
      async (id) => {
        deleted.push(id);
      },
      (...p) => progress.push(p),
    ),
    4,
  );
  assert.deepEqual(deleted, ["a", "b", "c", "d"]);
  assert.deepEqual(progress, [
    ["a", 1, 4],
    ["b", 2, 4],
    ["c", 3, 4],
    ["d", 4, 4],
  ]);
});
test("a failed deletion reports partial progress and does not remove remaining entries", async () => {
  const attempts: string[] = [],
    removed: string[] = [];
  await assert.rejects(
    clearFinishedHistory(
      [run("a", "completed"), run("b", "completed"), run("c", "completed")],
      async (id) => {
        attempts.push(id);
        if (id === "b") throw new Error("Daemon disconnected");
      },
      (id) => removed.push(id),
    ),
    /Cleared 1 of 3.*Remaining entries were kept.*Daemon disconnected/,
  );
  assert.deepEqual(attempts, ["a", "b"]);
  assert.deepEqual(removed, ["a"]);
});
test("newly completed runs are not included in an already reviewed batch", async () => {
  const runs = [run("a", "completed")],
    deleted: string[] = [];
  await clearFinishedHistory(
    runs,
    async (id) => {
      deleted.push(id);
      runs.push(run("new", "completed"));
    },
    () => {},
  );
  assert.deepEqual(deleted, ["a"]);
  assert.equal(
    await clearFinishedHistory(
      [run("p", "paused")],
      async () => {
        throw new Error("must not call");
      },
      () => {},
    ),
    0,
  );
});
