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
  assert.ok(recordedDemos.length >= 6);
  assert.equal(
    new Set(recordedDemos.map((d) => d.id)).size,
    recordedDemos.length,
  );
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
      demo.group === "snapshots"
        ? demo.frames >= 1 && demo.frames <= 5 && demo.particles >= 60000
        : demo.frames >= 40 && demo.particles >= 10000 && demo.duration >= 3.9,
    );
  }
});

test("the shipped KHH example opens with periodic domain, exact identities and recorded internal/total energies", async () => {
  const h5 = await import("h5wasm/node");
  await h5.ready;
  const { HDF5Source } = await import("../web/src/sources/hdf5");
  const demo = recordedDemos.find((d) => d.id === "demo-khh-crksph-256")!;
  const file = new h5.File(
    new URL(`../web/public/demos/${demo.file}`, import.meta.url).pathname,
    "r",
  );
  const source = new HDF5Source(demo.id, demo.name, file, h5);
  try {
    const metadata = await source.metadata();
    assert.equal(metadata.frames, demo.frames);
    assert.equal(metadata.frames, 41);
    assert.equal(metadata.times.at(-1), demo.duration);
    assert.equal(metadata.dimension, 2);
    assert.equal(metadata.identity, "UIDs");
    assert.equal(metadata.internalEnergyAvailable, true);
    assert.deepEqual(metadata.domain?.periodic, [true, true]);
    for (const index of [0, 20, 40]) {
      const raw = await source.read(index, "velocities");
      assert.equal(raw.positions.shape[0], 65536);
      assert.equal(new Set(Array.from(raw.UIDs.data, String)).size, 65536);
      const diagnostic = source.recordedDiagnostic(index)!;
      assert.ok(Number.isFinite(diagnostic.internalEnergy));
      assert.ok(Number.isFinite(diagnostic.totalEnergy));
      assert.ok(
        Math.abs(
          diagnostic.totalEnergy! -
            diagnostic.internalEnergy! -
            diagnostic.kineticEnergy!,
        ) < 1e-8,
      );
    }
  } finally {
    source.close();
  }
});

test("high-resolution solver snapshots open with valid physical arrays and stable identities", async () => {
  const h5 = await import("h5wasm/node");
  const { HDF5Source } = await import("../web/src/sources/hdf5");
  await h5.ready;
  for (const demo of recordedDemos.filter((d) => d.group === "snapshots")) {
    const source = new HDF5Source(
      demo.id,
      demo.name,
      new h5.File(
        new URL(`../web/public/demos/${demo.file}`, import.meta.url).pathname,
        "r",
      ),
      h5,
    );
    try {
      const metadata = await source.metadata();
      assert.equal(metadata.frames, demo.frames);
      assert.equal(metadata.dimension, 2);
      assert.equal(metadata.identity, "UIDs");
      assert.ok(metadata.domain);
      let first: string[] | undefined;
      for (const index of [0, demo.frames - 1]) {
        const raw = await source.read(index, "velocities");
        assert.equal(raw.positions.shape[0], demo.particles);
        assert.equal(raw.velocities.shape[1], 2);
        assert.ok(
          Array.from(raw.velocities.data, Number).every(Number.isFinite),
        );
        for (const key of ["masses", "densities", "supports"]) {
          assert.ok(
            Array.from(raw[key].data, Number).every(
              (v) => Number.isFinite(v) && v > 0,
            ),
          );
        }
        const ids = Array.from(raw.UIDs.data, String);
        assert.equal(new Set(ids).size, demo.particles);
        if (first) assert.deepEqual(ids, first);
        else first = ids;
      }
    } finally {
      source.close();
    }
  }
});
