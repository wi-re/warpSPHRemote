import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompanionClient,
  liveConnectionStatus,
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
    assert.equal(a?.transfer?.bytes, dynamic.byteLength + statics.byteLength);
    assert.equal(a?.transfer?.staticBytes, statics.byteLength);
    assert.equal(b?.transfer?.bytes, dynamic.byteLength);
    assert.equal(b?.transfer?.staticBytes, 0);
    assert.ok(a!.transfer!.durationMs >= 0);
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

test("recorded history uses authenticated frame reads, retains exact IDs and reuses its bounded cache", async () => {
  const { RecordedSource } = await import("../web/src/companion");
  const original = globalThis.fetch;
  const calls: string[] = [];
  const metadata = {
    id: "",
    name: "test",
    format: "recording",
    frames: 2,
    times: [0.1, 0.2],
    timeKind: "simulation",
    dimension: 2,
    fields: [],
    bounds: [
      [0, 0],
      [1, 1],
    ],
    identity: "UIDs",
  };
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer secret",
    );
    if (String(url).endsWith("/history"))
      return new Response(JSON.stringify(metadata));
    const index = Number(new URL(String(url)).searchParams.get("index"));
    const raw = packet(
      {
        positions: { data: new Float32Array([0, 0]), shape: [1, 2] },
        UIDs: { data: new BigInt64Array([2n ** 54n + 1n]), shape: [1] },
        kinds: { data: new Int32Array([0]), shape: [1] },
        masses: { data: new Float32Array([1]), shape: [1] },
        velocities: { data: new Float32Array([1, 0]), shape: [1, 2] },
      },
      metadata.times[index],
    );
    // The helper writes index=10; this fixture only checks source transport/cache.
    return new Response(raw);
  };
  try {
    const client = new CompanionClient("http://127.0.0.1:8766", "secret");
    const info = await client.recording("run");
    assert.equal(info.id, "history-run");
    const reader = new RecordedSource(info, client, "run");
    const frame = await reader.frame(0, "velocities");
    assert.equal(frame.arrays.UIDs.data[0], 2n ** 54n + 1n);
    assert.equal(await reader.frame(0, "velocities"), frame);
    assert.equal(calls.filter((c) => c.includes("/history/frame")).length, 1);
    assert.equal((await reader.diagnostics(0, 1))[0].kineticEnergy, 0.5);
    metadata.frames = 3;
    metadata.times.push(0.3);
    await reader.refresh();
    assert.equal(reader.metadata.frames, 3);
    reader.close();
  } finally {
    globalThis.fetch = original;
  }
});

test("page-exit detach keeps the authenticated lease release alive", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:8766/v1/runs/run/detach");
    assert.equal(init?.method, "POST");
    assert.equal(init?.keepalive, true);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-token",
    );
    return new Response("{}");
  };
  try {
    await new CompanionClient("http://127.0.0.1:8766", "test-token").detach(
      "run",
      true,
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("live connection notice distinguishes startup, first frame, and capture failures", () => {
  const run = {
    status: "starting",
    stale: false,
  } as import("../web/src/companion").Simulation;
  assert.equal(liveConnectionStatus(run), "waiting for startup…");
  assert.equal(
    liveConnectionStatus({ ...run, status: "running" }),
    "waiting for the first live frame…",
  );
  const message = "Live capture unavailable: increase --max-snapshot-mib";
  assert.equal(
    liveConnectionStatus({ ...run, status: "running", message }),
    message,
  );
  assert.equal(
    liveConnectionStatus({ ...run, status: "paused", stale: true }),
    "waiting for a producer heartbeat…",
  );
});

test("identical live safe boundaries do not trigger another visualization update", () => {
  const f = decodeFrame(
    packet({
      positions: { data: new Float32Array([0, 0]), shape: [1, 2] },
      UIDs: { data: new Int32Array([1]), shape: [1] },
      kinds: { data: new Int32Array([0]), shape: [1] },
      masses: { data: new Float32Array([1]), shape: [1] },
    }),
  );
  f.step = 20;
  const metadata = {
    id: "live-run",
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
    name: "paused",
    format: "Live simulation",
  } as const;
  const snapshot = {
    frame: f,
    metadata: {
      ...metadata,
      fields: [],
      bounds: [
        [0, 0],
        [1, 1],
      ],
      times: [0.1],
    },
    sequence: 1,
  } as Snapshot;
  const source = new LiveSource(snapshot, async () => {});
  assert.ok(
    source.sameState({
      ...snapshot,
      sequence: 2,
      frame: { ...f, arrays: { ...f.arrays } },
    }),
  );
  assert.ok(!source.sameState({ ...snapshot, frame: { ...f, step: 21 } }));
  assert.ok(!source.sameState({ ...snapshot, frame: { ...f, time: 0.2 } }));
  assert.ok(
    !source.sameState({
      ...snapshot,
      frame: { ...f, arrays: { ...f.arrays, UIDs: { ...f.arrays.UIDs } } },
    }),
  );
});

test("takeover is an explicit attachment request and ownership conflicts stay distinct from offline failures", async () => {
  const {
    viewerConnectionConflict,
    companionUnavailableMessage,
    CompanionHTTPError,
  } = await import("../web/src/companion");
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  };
  try {
    const client = new CompanionClient("http://127.0.0.1:8766", "fixture");
    await client.attach("run");
    await client.attach("run", true);
    await client.request("/v1/runs/run/attach", {}); // Heartbeat never forces ownership.
    assert.deepEqual(bodies, [{}, { takeover: true }, {}]);
    assert(
      viewerConnectionConflict(
        new CompanionHTTPError(409, "new text", "viewer_conflict"),
      ),
    );
    assert(
      viewerConnectionConflict(
        new CompanionHTTPError(
          409,
          "A viewer already owns the live connection.",
        ),
      ),
    );
    assert(
      !viewerConnectionConflict(
        new CompanionHTTPError(409, "stale acknowledgement"),
      ),
    );
    assert.equal(
      companionUnavailableMessage(new CompanionHTTPError(409, "lease")),
      null,
    );
    assert.equal(
      companionUnavailableMessage(new CompanionHTTPError(404, "run ended")),
      null,
    );
    assert.match(
      companionUnavailableMessage(new TypeError("Failed to fetch"))!,
      /reconnect automatically/,
    );
    assert.match(
      companionUnavailableMessage(
        new DOMException("deadline", "TimeoutError"),
      )!,
      /unavailable/,
    );
    assert.match(
      companionUnavailableMessage(new CompanionHTTPError(401, "bad token"))!,
      /pair again/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("remote endpoints require HTTPS and retain browser address-space classification", async () => {
  const { companionAddressSpace, remoteConnection } =
    await import("../web/src/companion");
  assert.throws(
    () => companionEndpoint("http://192.168.1.20:8767"),
    /require HTTPS/,
  );
  assert.throws(
    () => companionEndpoint("http://simulation.example:8767"),
    /require HTTPS/,
  );
  assert.equal(
    companionEndpoint("https://192.168.1.20:8767/"),
    "https://192.168.1.20:8767",
  );
  assert.equal(companionEndpoint("http://[::1]:8766"), "http://[::1]:8766");
  assert.equal(companionAddressSpace("https://192.168.1.20:8767"), "local");
  assert.equal(companionAddressSpace("https://[fd00::2]:8767"), "local");
  assert.equal(companionAddressSpace("https://203.0.113.20:8767"), undefined);
  assert.equal(
    companionAddressSpace("https://simulation.example:8767"),
    undefined,
  );
  assert.equal(remoteConnection("http://127.0.0.1:8766"), false);
  assert.equal(remoteConnection("https://simulation.example:8767"), true);
  const old = globalThis.fetch;
  const inits: any[] = [];
  globalThis.fetch = async (_url, init) => {
    inits.push(init);
    return new Response("{}");
  };
  try {
    await new CompanionClient(
      "https://simulation.example:8767",
      "remote-secret",
    ).request("/v1/session");
    await new CompanionClient(
      "https://192.168.1.20:8767",
      "remote-secret",
    ).request("/v1/session");
    assert.equal("targetAddressSpace" in inits[0], false);
    assert.equal(inits[1].targetAddressSpace, "local");
    assert.equal(inits[0].headers.Authorization, "Bearer remote-secret");
    assert.match(
      companionConnectionMessage(
        new TypeError("fetch"),
        "https://simulation.example:8767",
      ),
      /certificate trust/,
    );
  } finally {
    globalThis.fetch = old;
  }
});

test("slow frame download stays cancellable and does not hold control requests", async () => {
  const old = globalThis.fetch;
  const abort = new AbortController();
  let frameSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/snapshot")) {
      frameSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          frameSignal?.addEventListener(
            "abort",
            () =>
              controller.error(
                new DOMException("Download cancelled", "AbortError"),
              ),
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: {
          "X-Static-Revision": "one",
          "X-Snapshot-Sequence": "1",
          "X-Snapshot-Metadata": JSON.stringify({ dimension: 2, fields: [] }),
        },
      });
    }
    return new Response(JSON.stringify({ runs: [] }));
  };
  try {
    const client = new CompanionClient(
      "https://simulation.example:8767",
      "remote-token",
    );
    const frame = client.snapshot("run", abort.signal);
    assert.deepEqual(await client.runs(), []);
    assert.equal(frameSignal, abort.signal); // No total-duration deadline on a particle frame.
    abort.abort();
    await assert.rejects(frame, /cancelled/);
  } finally {
    globalThis.fetch = old;
  }
});
