/** CPU-only full-viewer memory reproduction; never contacts a real daemon.
 * Build outside source, then run from the repository root:
 * npm run build -- --outDir /tmp/remote-memory-build
 * node --import tsx examples/live_memory_fixture.mts --build /tmp/remote-memory-build
 * Open the printed URL and choose Watch live. The overlay reports JS heap
 * (Chromium performance.memory), not total browser RSS/GPU memory. Streams
 * 524,288 synthetic particles then stops offering frames at --frames (200).
 * The dummy pairing value is public fixture data. Do not use this server as
 * a production companion. Ctrl+C stops only this synthetic HTTP fixture.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve, sep } from "node:path";
const { values } = parseArgs({
  options: {
    build: { type: "string" },
    port: { type: "string", default: "18790" },
    frames: { type: "string", default: "200" },
  },
});
if (!values.build)
  throw Error("Pass --build with a production build directory outside source.");
const build = resolve(values.build),
  port = Number(values.port),
  limit = Number(values.frames);
if (
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 10000
)
  throw Error("Invalid port/frame limit");
const n = 524288;
function packet(arrays: any) {
  let size = 0;
  const specs: any = {};
  for (const [name, a] of Object.entries(arrays) as any) {
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
    JSON.stringify({ version: 1, index: 0, time: 0, arrays: specs }),
  );
  const base = 8 + Math.ceil(text.length / 8) * 8,
    out = new ArrayBuffer(base + size);
  new DataView(out).setUint32(0, 0x31525057, true);
  new DataView(out).setUint32(4, text.length, true);
  new Uint8Array(out, 8, text.length).set(text);
  for (const [name, a] of Object.entries(arrays) as any)
    new Uint8Array(out, base + specs[name].offset, a.data.byteLength).set(
      new Uint8Array(a.data.buffer),
    );
  return Buffer.from(out);
}
const positions = new Float32Array(n * 2);
for (let i = 0; i < n; i++) {
  positions[2 * i] = (i % 4096) / 128 - 12;
  positions[2 * i + 1] = Math.floor(i / 4096) / 128 - 0.5;
}
const dynamic = packet({
  supports: { data: new Float32Array(n).fill(0.03), shape: [n] },
  pressures: { data: new Float32Array(n).fill(1), shape: [n] },
  internalEnergies: { data: new Float32Array(n).fill(2.5), shape: [n] },
  materials: { data: new Int32Array(n), shape: [n] },
  positions: { data: positions, shape: [n, 2] },
  velocities: { data: new Float32Array(n * 2), shape: [n, 2] },
  densities: { data: new Float32Array(n).fill(1), shape: [n] },
});
const statics = packet({
  UIDs: { data: new BigInt64Array(n), shape: [n] },
  kinds: { data: new Int32Array(n), shape: [n] },
  masses: { data: new Float32Array(n).fill(1 / n), shape: [n] },
});
let seq = 0;

let attached = false;
const run = () => ({
  id: "fixture",
  name: "Memory reproduction",
  status: "running",
  registered: true,
  createdBy: "simulation",
  pid: 123,
  step: seq,
  time: seq * 0.01,
  dt: 0.001,
  particles: n,
  dimension: 2,
  scheme: "CRKSPH",
  sequence: seq,
  updatedAt: Date.now() / 1000,
  startedAt: Date.now() / 1000,
  visualized: attached,
  stale: false,
  capabilities: [],
  performance: { stepMs: 100, targetTime: 100 },
  frameBuffer: { ready: true, bytes: dynamic.length, ageSeconds: 0 },
});
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  let body: Buffer;
  let kind = "application/json";
  if (url.pathname === "/v1/session")
    body = Buffer.from(
      JSON.stringify({
        version: 1,
        presets: [],
        features: ["pause", "viewerTakeover", "bufferedCapture"],
      }),
    );
  else if (url.pathname === "/v1/runs")
    body = Buffer.from(JSON.stringify({ revision: seq, runs: [run()] }));
  else if (url.pathname.endsWith("/attach")) {
    attached = true;
    body = Buffer.from(JSON.stringify(run()));
  } else if (url.pathname.endsWith("/detach")) {
    attached = false;
    body = Buffer.from('{"ok":true}');
  } else if (url.pathname.endsWith("/snapshot")) {
    if (seq >= limit) {
      res.statusCode = 204;
      res.end();
      return;
    }
    seq++;
    kind = "application/octet-stream";
    res.setHeader("X-Static-Revision", "one");
    res.setHeader("X-Snapshot-Sequence", String(seq));
    res.setHeader(
      "X-Snapshot-Metadata",
      JSON.stringify({
        name: "Memory reproduction",
        bounds: [
          [-12, -0.5],
          [20, 0.5],
        ],
        domain: { min: [-12, -0.5], max: [20, 0.5], periodic: [true, true] },
        dimension: 2,
        fields: [
          "densities",
          "velocities",
          "supports",
          "masses",
          "UIDs",
          "kinds",
          "materials",
          "pressures",
          "internalEnergies",
        ].map((name) => ({
          name,
          components: name === "velocities" ? 2 : 1,
          dtype: name === "UIDs" ? "BigInt64Array" : "Float32Array",
        })),
        step: seq,
      }),
    );
    body = dynamic;
  } else if (url.pathname.endsWith("/static")) {
    kind = "application/octet-stream";
    body = statics;
  } else if (url.pathname.startsWith("/v1/")) body = Buffer.from('{"ok":true}');
  else {
    const relative = url.pathname
      .replace(/^\/warpSPHRemote\//, "")
      .replace(/^\//, "");
    try {
      if (!relative || relative === "index.html") {
        kind = "text/html";
        body = Buffer.from(
          readFileSync(resolve(build, "index.html"), "utf8").replace(
            "</body>",
            `<pre id="fixtureStats" style="position:fixed;left:0;bottom:0;z-index:999999;color:white;background:black"></pre><script>setInterval(()=>{document.getElementById('fixtureStats').textContent='heap MiB: '+Math.round(performance.memory.usedJSHeapSize/2**20)},1000)</script></body>`,
          ),
        );
      } else {
        kind = relative.endsWith(".js")
          ? "text/javascript"
          : relative.endsWith(".css")
            ? "text/css"
            : "application/octet-stream";
        const target = resolve(build, relative);
        if (!target.startsWith(build + sep)) throw Error("outside build");
        body = readFileSync(target);
      }
    } catch {
      res.statusCode = 404;
      body = Buffer.from("not found");
    }
  }
  res.setHeader("Content-Type", kind);
  res.setHeader("Content-Length", body.length);
  res.end(body);
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
console.log(
  `Synthetic memory fixture: http://127.0.0.1:${port}/warpSPHRemote/#companion=http%3A%2F%2F127.0.0.1%3A${port}&pair=public-isolated-fixture (stop with Ctrl+C)`,
);
