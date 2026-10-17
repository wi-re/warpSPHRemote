import test from "node:test";
import assert from "node:assert/strict";
import { selectionIndex } from "../web/src/sources/selection";
import { readPreferences, savePreferences } from "../web/src/preferences";
import type { Frame } from "../web/src/types";
test("plot selection follows exact UIDs through row reordering and missing frames without retargeting another particle", () => {
  const make = (index: number, ids?: bigint[]) =>
    ({
      index,
      time: index,
      bytes: 0,
      arrays: {
        positions: { data: new Float32Array(6), shape: [3, 2] },
        ...(ids ? { UIDs: { data: BigInt64Array.from(ids), shape: [3] } } : {}),
      },
    }) as Frame;
  const uid = 2n ** 54n + 1n,
    selection = { sourceId: "a", frame: 0, index: 0, uid: String(uid) };
  assert.equal(selectionIndex(selection, "a", make(0, [uid, 2n, 3n])), 0);
  assert.equal(selectionIndex(selection, "a", make(1, [3n, 2n, uid])), 2);
  assert.equal(selectionIndex(selection, "a", make(2, [3n, 2n, uid - 1n])), -1);
  assert.equal(selectionIndex(selection, "b", make(0, [uid, 2n, 3n])), -1);
  assert.equal(selectionIndex(selection, "a", make(0)), -1);
  const row = { sourceId: "a", frame: 0, index: 1 };
  assert.equal(selectionIndex(row, "a", make(0)), 1);
  assert.equal(selectionIndex(row, "a", make(1)), -1);
});
test("viewer settings persist without a recording and tolerate corrupt/unavailable browser storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    },
  });
  try {
    const preferences = {
      theme: "light" as const,
      backend: "cpu" as const,
      wrapPeriodic: false,
    };
    savePreferences(preferences);
    assert.deepEqual(readPreferences(), preferences);
    values.set(
      "warpsph-viewer-preferences",
      '{"theme":"invalid","backend":"cuda","wrapPeriodic":2}',
    );
    assert.deepEqual(readPreferences(), {
      theme: "dark",
      backend: "auto",
      wrapPeriodic: true,
    });
    values.set("warpsph-viewer-preferences", "corrupt{");
    assert.equal(readPreferences().backend, "auto");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    assert.doesNotThrow(() => savePreferences(preferences));
    assert.equal(readPreferences().theme, "dark");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
