import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  downloadDemo,
  recordedDemos,
  type RecordedDemo,
} from "../web/src/recordedDemos";

const bytes = new Uint8Array([137, 72, 68, 70, 13, 10, 26, 10]);
const fixture: RecordedDemo = {
  id: "demo-fixture",
  name: "Fixture",
  file: "fixture.h5",
  description: "test",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  particles: 1,
  frames: 1,
  duration: 0,
};
test("demo downloads honor the Pages base path, report progress and verify bytes", async () => {
  const progress: number[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "/warpSPHRemote/demos/fixture.h5");
    assert.ok(init?.signal);
    return new Response(bytes);
  };
  const file = await downloadDemo(
    fixture,
    new AbortController().signal,
    (n) => progress.push(n),
    "/warpSPHRemote/",
    fetcher,
  );
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.equal(file.lastModified, 0);
  assert.equal(file.name, "fixture.h5");
  assert.equal(progress.at(-1), bytes.length);
});
test("failed, incomplete, corrupt and cancelled demo downloads cannot open as recordings", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    downloadDemo(
      fixture,
      signal,
      () => {},
      "./",
      async () => new Response(null, { status: 404 }),
    ),
    /404/,
  );
  await assert.rejects(
    downloadDemo(
      fixture,
      signal,
      () => {},
      "./",
      async () => new Response(bytes.slice(1)),
    ),
    /incomplete/,
  );
  await assert.rejects(
    downloadDemo(
      { ...fixture, sha256: "bad" },
      signal,
      () => {},
      "./",
      async () => new Response(bytes),
    ),
    /match/,
  );
  const abort = new AbortController();
  await assert.rejects(
    downloadDemo(
      fixture,
      abort.signal,
      () => abort.abort(),
      "./",
      async () => new Response(bytes),
    ),
    { name: "AbortError" },
  );
});
test("shipped demo catalogue matches the committed HDF5 files and checksums", () => {
  assert.equal(recordedDemos.length, 2);
  assert.equal(new Set(recordedDemos.map((d) => d.id)).size, 2);
  for (const demo of recordedDemos) {
    assert.ok(demo.id.startsWith("demo-"));
    assert.match(demo.file, /^[a-z0-9-]+\.h5$/);
    const data = readFileSync(
      new URL(`../web/public/demos/${demo.file}`, import.meta.url),
    );
    assert.equal(data.byteLength, demo.bytes);
    assert.equal(createHash("sha256").update(data).digest("hex"), demo.sha256);
    assert.deepEqual(data.subarray(0, 8), Buffer.from(bytes));
    assert.ok(
      demo.frames >= 50 && demo.particles >= 10000 && demo.duration >= 5,
    );
  }
});
