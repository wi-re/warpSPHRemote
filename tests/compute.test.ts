import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareParticles,
  PARTICLE_STRIDE,
} from "../web/src/compute/particles";
import { fixture } from "../web/src/compute/fixtures";
import { GridBackend } from "../web/src/compute/backend";
import { queryBatches, CANDIDATES_PER_BATCH } from "../web/src/compute/batches";
import { initialGrid, reconstructGridAsync } from "../web/src/sources/grid";
const source = { domain: { min: [0, 0], max: [1, 1], periodic: [true, true] } };
test("GPU snapshot uses local periodic coordinates, exact masks and full cutoff supports without changing source data", () => {
  const raw = fixture(),
    before = raw.positions.data.slice();
  raw.UIDs = {
    data: new BigUint64Array(157).fill(2n ** 60n + 1n),
    shape: [157],
  };
  raw.test.data[1] = NaN;
  raw.velocities.data[4] = NaN;
  raw.masses.data[3] = 0;
  const p = prepareParticles(raw, source, "test", "magnitude", initialGrid),
    f = new Float32Array(p.data),
    u = new Uint32Array(p.data);
  assert.equal(p.data.byteLength, 157 * PARTICLE_STRIDE);
  assert.equal(p.excluded, 1);
  assert.equal(u[10], 0); // boundary particle
  assert.equal(u[12 + 10], 5); // valid volume + velocity; invalid field
  assert.equal(u[24 + 10], 3); // valid volume + field; invalid velocity
  assert.equal(u[36 + 10], 0); // invalid volume excluded
  for (let i = 0; i < 157; i++)
    if (u[i * 12 + 10] & 1) {
      assert.ok(f[i * 12] >= 0 && f[i * 12] <= 1);
      assert.equal(f[i * 12 + 2], Math.fround(Number(raw.supports.data[i])));
    }
  assert.deepEqual(raw.positions.data, before);
  assert.equal(raw.UIDs.data[0], 2n ** 60n + 1n);
});
test("packing rejects unsupported precision but retains dense work for batched queries", () => {
  const raw = fixture();
  raw.supports.data[1] = 1e-30;
  assert.throws(
    () => prepareParticles(raw, source, "test", "magnitude", initialGrid),
    /precision/,
  );
  const crowded = fixture(2000);
  (crowded.supports.data as Float64Array).fill(2);
  const packed = prepareParticles(crowded, source, "test", "magnitude", {
    ...initialGrid,
    resolution: 512,
  });
  assert.ok(packed.candidates > 160_000_000);
  assert.equal(packed.data.byteLength, 2000 * PARTICLE_STRIDE);
});
test("backend selects CPU explicitly, reports unavailable WebGPU honestly, and skips aborted queued work", async () => {
  const backend = new GridBackend(),
    raw = fixture();
  const cpu = await backend.reconstruct(raw, source, "test", "magnitude", {
    ...initialGrid,
    backend: "cpu",
  });
  assert.equal(cpu.compute?.backend, "cpu");
  assert.equal(cpu.compute?.reason, undefined);
  const auto = await backend.reconstruct(
    raw,
    source,
    "test",
    "magnitude",
    initialGrid,
  );
  assert.equal(auto.compute?.backend, "cpu");
  assert.match(auto.compute?.reason ?? "", /unavailable/);
  await assert.rejects(
    backend.reconstruct(raw, source, "test", "magnitude", {
      ...initialGrid,
      backend: "webgpu",
    }),
    /WebGPU.*unavailable/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    backend.reconstruct(
      raw,
      source,
      "test",
      "magnitude",
      initialGrid,
      0,
      0,
      abort.signal,
    ),
    { name: "AbortError" },
  );
  await backend.close();
});

test("GPU query batches cover all cells exactly once without imposing a total work cap", () => {
  for (const candidates of [0, 100, 2000, CANDIDATES_PER_BATCH * 2]) {
    const count = 1031,
      batches = [...queryBatches(count, candidates, 2)];
    let next = 0;
    for (const batch of batches) {
      assert.equal(batch.offset, next);
      assert.ok(batch.count > 0 && Math.ceil(batch.count / 128) <= 2);
      if (candidates <= CANDIDATES_PER_BATCH)
        assert.ok(
          batch.count * Math.max(1, candidates) <= CANDIDATES_PER_BATCH,
        );
      next += batch.count;
    }
    assert.equal(next, count);
  }
});

test("large CPU reconstructions yield, can be cancelled, and keep the complete dataset", async () => {
  const raw = fixture(701);
  (raw.supports.data as Float64Array).fill(2);
  (raw.test.data as Float64Array).fill(2.5);
  const abort = new AbortController();
  const pending = reconstructGridAsync(
    raw,
    source,
    "test",
    "magnitude",
    initialGrid,
    0,
    0,
    abort.signal,
  );
  setTimeout(() => abort.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const result = await reconstructGridAsync(
      raw,
      source,
      "test",
      "magnitude",
      initialGrid,
    );
    assert.ok(ticks > 0);
    assert.ok(
      [...result.values].every(
        (v) => Number.isFinite(v) && Math.abs(v - 2.5) < 1e-5,
      ),
    );
  } finally {
    clearInterval(timer);
  }
});
