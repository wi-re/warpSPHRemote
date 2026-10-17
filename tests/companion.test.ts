import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompanionClient,
  companionConnectionMessage,
  LiveSource,
  companionEndpoint,
  takePairing,
  type Snapshot,
} from "../web/src/companion";
import { decodeFrame } from "../web/src/data";

function packet(
  arrays: Record<
    string,
    { data: Float32Array | Int32Array | BigInt64Array; shape: number[] }
  >,
  time = 0.1,
) {
  const specs: Record<string, unknown> = {};
  let size = 0;
  for (const [name, a] of Object.entries(arrays)) {
    size = Math.ceil(size / 8) * 8;
    specs[name] = {
      dtype:
        a.data instanceof BigInt64Array
          ? "<i8"
          : a.data instanceof Int32Array
            ? "<i4"
            : "<f4",
      shape: a.shape,
      offset: size,
      bytes: a.data.byteLength,
    };
    size += a.data.byteLength;
  }
  const text = new TextEncoder().encode(
      JSON.stringify({ version: 1, index: 10, time, arrays: specs }),
    ),
    base = 8 + Math.ceil(text.length / 8) * 8,
    out = new ArrayBuffer(base + size);
  new Uint8Array(out).set([87, 80, 82, 49]);
  new DataView(out).setUint32(4, text.length, true);
  new Uint8Array(out, 8, text.length).set(text);
  for (const [name, a] of Object.entries(arrays))
    new Uint8Array(
      out,
      base + (specs[name] as any).offset,
      a.data.byteLength,
    ).set(new Uint8Array(a.data.buffer));
  return out;
}
test("pairing credentials are removed from history and are never URL query parameters", () => {
  let replaced = "";
  assert.deepEqual(
    takePairing(
      {
        hash: "#companion=http%3A%2F%2F127.0.0.1%3A8766&pair=secret",
        pathname: "/warpSPHRemote/",
        search: "?demo=test",
      },
      (url) => (replaced = url),
    ),
    { endpoint: "http://127.0.0.1:8766", token: "secret" },
  );
  assert.equal(replaced, "/warpSPHRemote/?demo=test");
  assert.equal(
    takePairing({ hash: "#other", pathname: "/", search: "" }, () =>
      assert.fail(),
    ),
    null,
  );
  for (const input of [
    "javascript:alert(1)",
    "http://user:pass@localhost:8766",
    "http://localhost:8766/path",
    "http://localhost:8766/?token=secret",
  ])
    assert.throws(() => companionEndpoint(input));
});
test("live snapshot merges exact static IDs, reuses static revision, and never auto-acknowledges", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const statics = packet({
    UIDs: { data: new BigInt64Array([2n ** 54n + 1n]), shape: [1] },
    kinds: { data: new Int32Array([0]), shape: [1] },
    masses: { data: new Float32Array([1]), shape: [1] },
  });
  const dynamic = packet({
    positions: { data: new Float32Array([0, 0]), shape: [1, 2] },
    velocities: { data: new Float32Array([1, 2]), shape: [1, 2] },
  });
  assert.throws(() => decodeFrame(statics), /positions/);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/static")) return new Response(statics);
    return new Response(dynamic, {
      headers: {
        "X-Static-Revision": "same",
        "X-Snapshot-Sequence": "1",
        "X-Snapshot-Metadata": JSON.stringify({
          dimension: 2,
          fields: [],
          bounds: [
            [0, 0],
            [1, 1],
          ],
          identity: "UIDs",
          step: 10,
        }),
      },
    });
  };
  try {
    const client = new CompanionClient("http://127.0.0.1:8766", "secret");
    const a = await client.snapshot("run"),
      b = await client.snapshot("run");
    assert.equal(a?.frame.arrays.UIDs.data[0], 2n ** 54n + 1n);
    assert.equal(a?.metadata.liveStep, 10);
    assert.equal(a?.frame.index, 0);
    assert.equal(a?.frame.step, 10);
    assert.equal(a?.frame.liveRevision, 1);
    assert.equal(a?.frame.arrays.UIDs, b?.frame.arrays.UIDs);
    assert.equal(calls.filter((c) => c.url.endsWith("/static")).length, 1);
    assert.ok(
      !calls.some((c) => c.url.includes("/ack") || c.url.includes("secret")),
    );
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer secret",
    );
    assert.equal((calls[0].init as any).targetAddressSpace, "loopback");
  } finally {
    globalThis.fetch = original;
  }
});
test("the live source acknowledges each rendered revision once and ignores obsolete displays", async () => {
  const frame = decodeFrame(
    packet({
      positions: { data: new Float32Array([0, 0]), shape: [1, 2] },
      velocities: { data: new Float32Array([1, 2]), shape: [1, 2] },
    }),
  );
  const snapshot: Snapshot = {
    sequence: 1,
    frame,
    metadata: {
      id: "live-run",
      name: "test",
      format: "Live simulation",
      dimension: 2,
      fields: [],
      bounds: [
        [0, 0],
        [1, 1],
      ],
      identity: "UIDs",
      frames: 1,
      times: [0.1],
      timeKind: "simulation",
      live: true,
      liveRevision: 1,
    },
  };
  let acknowledged = 0;
  const reader = new LiveSource(snapshot, async () => {
    acknowledged++;
  });
  await reader.frame(0, "velocities");
  assert.equal(acknowledged, 0);
  await reader.displayed(0);
  assert.equal(acknowledged, 0);
  await reader.displayed(1);
  await reader.displayed(1);
  assert.equal(acknowledged, 1);
  reader.update(
    { ...snapshot, metadata: { ...snapshot.metadata, liveRevision: 2 } },
    async () => {
      acknowledged++;
    },
  );
  await reader.displayed(1);
  assert.equal(acknowledged, 1);
  await reader.displayed(2);
  assert.equal(acknowledged, 2);
  reader.close();
});

test("pairing permits a longer permission decision while ordinary requests retain their deadline and cancellation", async () => {
  const fetchOriginal = globalThis.fetch,
    timeoutOriginal = AbortSignal.timeout;
  const deadlines: { ms: number; controller: AbortController }[] = [];
  const requests: {
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }[] = [];
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    deadlines.push({ ms, controller });
    return controller.signal;
  };
  globalThis.fetch = async (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init!.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      requests.push({ signal, resolve });
    });
  try {
    const client = new CompanionClient("http://127.0.0.1:8766", "secret"),
      pairing = client.session();
    assert.equal(deadlines[0].ms, 60_000);
    const ordinary = client.request("/v1/runs");
    assert.equal(deadlines[1].ms, 10_000);
    deadlines[1].controller.abort(new DOMException("Expired", "TimeoutError"));
    await assert.rejects(ordinary, { name: "TimeoutError" });
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve(
      new Response(JSON.stringify({ version: 1, presets: [] })),
    );
    assert.equal((await pairing).version, 1);
    const cancel = new AbortController(),
      cancelled = client.session(cancel.signal);
    cancel.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
  } finally {
    globalThis.fetch = fetchOriginal;
    AbortSignal.timeout = timeoutOriginal;
  }
});
test("connection messages distinguish token rejection, permission wait timeout, and opaque browser network errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "A valid token is required." }), {
      status: 401,
    });
  try {
    const client = new CompanionClient("http://127.0.0.1:8766", "old-token");
    await assert.rejects(client.session(), (error) => {
      assert.match(companionConnectionMessage(error), /current token/);
      assert.doesNotMatch(companionConnectionMessage(error), /permission/);
      return true;
    });
    assert.match(
      companionConnectionMessage(new DOMException("Expired", "TimeoutError")),
      /clicked Allow/,
    );
    assert.match(
      companionConnectionMessage(new TypeError("Failed to fetch")),
      /Web Console/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
