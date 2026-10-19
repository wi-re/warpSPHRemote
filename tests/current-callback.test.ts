import { test } from "node:test";
import assert from "node:assert/strict";
import { currentCallback } from "../web/src/currentCallback";

test("stable callback dispatches to the latest render without preserving its predecessor", async () => {
  const calls: string[] = [];
  const slot = currentCallback((value: number) => {
    calls.push("old");
    return value + 1;
  });
  const exposedControl = slot.call;
  assert.equal(exposedControl(3), 4);
  slot.current = (value) => {
    calls.push("new");
    return value * 2;
  };
  assert.equal(slot.call, exposedControl);
  assert.equal(exposedControl(3), 6);
  assert.deepEqual(calls, ["old", "new"]);
  slot.current = () => {
    throw new Error("current failure");
  };
  assert.throws(() => exposedControl(3), /current failure/);
  const asyncSlot = currentCallback(async (value: number) => value);
  const exposedAsync = asyncSlot.call;
  asyncSlot.current = async () => {
    throw new Error("current rejection");
  };
  await assert.rejects(exposedAsync(3), /current rejection/);
});

test(
  "replaced large callback captures can be collected while control remains alive",
  { skip: !globalThis.gc },
  async () => {
    const slot = currentCallback(() => 0);
    const control = slot.call;
    const references: WeakRef<ArrayBuffer>[] = [];
    for (let i = 0; i < 60; i++) {
      const frame = new ArrayBuffer(1024 * 1024);
      new Uint8Array(frame)[0] = i;
      references.push(new WeakRef(frame));
      slot.current = () => new Uint8Array(frame)[0];
      assert.equal(control(), i);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.gc!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(references.filter((r) => r.deref()).length <= 2);
    assert.equal(control(), 59);
  },
);
