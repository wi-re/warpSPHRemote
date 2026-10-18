import test from "node:test";
import assert from "node:assert/strict";
import {
  recallPairing,
  rememberPairing,
  forgetPairing,
  samePairingEndpoint,
} from "../web/src/pairing";
import { canPauseSimulation, type Simulation } from "../web/src/companion";

test("pairing survives fresh reads, replaces only its browser slot and can be forgotten", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>([
    ["warpsph-viewer-preferences", "unchanged"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    assert.equal(recallPairing(), null);
    assert.equal(
      rememberPairing({
        endpoint: "http://127.0.0.1:8766/",
        token: " test-token ",
      }),
      true,
    );
    assert.deepEqual(recallPairing(), {
      endpoint: "http://127.0.0.1:8766",
      token: "test-token",
    });
    assert(samePairingEndpoint(recallPairing()!, "http://127.0.0.1:8766/"));
    assert(!samePairingEndpoint(recallPairing()!, "http://192.168.1.9:8766/"));
    assert(!samePairingEndpoint(recallPairing()!, "http://127.0.0.1:8767/"));
    assert(!samePairingEndpoint(recallPairing()!, "not a URL"));
    assert.equal(
      rememberPairing({
        endpoint: "http://127.0.0.1:8766",
        token: "rotated-token",
      }),
      true,
    );
    assert.equal(recallPairing()?.token, "rotated-token");
    assert.equal(forgetPairing(), true);
    assert.equal(recallPairing(), null);
    assert.equal(values.get("warpsph-viewer-preferences"), "unchanged");
    values.set("warpsph-companion-pairing-v1", "{bad json");
    assert.equal(recallPairing(), null);
    assert.equal(
      rememberPairing({
        endpoint: "https://example.com/path?pair=secret",
        token: "secret",
      }),
      false,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("blocked browser storage leaves pairing usable in memory without throwing", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assert.equal(recallPairing(), null);
    assert.equal(
      rememberPairing({ endpoint: "http://127.0.0.1:8766", token: "test" }),
      false,
    );
    assert.equal(forgetPairing(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("live simulation controls depend on producer capability and lifecycle, independently of snapshot count", () => {
  const run = { registered: true, status: "running" } as Simulation;
  assert(canPauseSimulation(run, ["pause"]));
  assert(canPauseSimulation({ ...run, status: "paused" }, ["pause"]));
  assert(!canPauseSimulation(run, []));
  assert(!canPauseSimulation({ ...run, registered: false }, ["pause"]));
  assert(!canPauseSimulation({ ...run, status: "stopped" }, ["pause"]));
});
