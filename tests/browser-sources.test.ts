import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { decodeNPY, NPZSource } from "../web/src/sources/npz";
import {
  DemoSource,
  displayFrame,
  reduceDiagnostic,
  type RawFrame,
} from "../web/src/sources/core";
import { HDF5Source } from "../web/src/sources/hdf5";
import * as h5 from "h5wasm/node";

function npy(
  data: Float32Array | BigInt64Array,
  shape: number[],
  fortran = false,
) {
  const header = `{'descr': '${data instanceof BigInt64Array ? "<i8" : "<f4"}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': (${shape.join(",")}${shape.length === 1 ? "," : ""}), }`;
  const padded =
      header + " ".repeat((64 - ((10 + header.length + 1) % 64)) % 64) + "\n",
    text = strToU8(padded),
    bytes = new Uint8Array(10 + text.length + data.byteLength);
  bytes.set([147, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(bytes.buffer).setUint16(8, text.length, true);
  bytes.set(text, 10);
  bytes.set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    10 + text.length,
  );
  return bytes;
}
test("NumPy parser preserves 64-bit UIDs and rejects unsupported/truncated arrays", () => {
  const input = npy(new BigInt64Array([2n ** 54n + 1n, 3n]), [2]);
  assert.equal(decodeNPY(input).data[0], 2n ** 54n + 1n);
  assert.throws(
    () => decodeNPY(input.subarray(0, input.length - 1)),
    /truncated/,
  );
  assert.throws(
    () => decodeNPY(npy(new Float32Array(4), [2, 2], true)),
    /Fortran/,
  );
});
test("selected NPZ sequence uses measurement time and natural ordering", async () => {
  const make = (name: string) =>
    new File(
      [
        zipSync({
          "positions.npy": npy(new Float32Array([0, 0, 1, 1]), [2, 2]),
          "velocities.npy": npy(new Float32Array([3, 4, 0, 2]), [2, 2]),
          "masses.npy": npy(new Float32Array([2, 3]), [2]),
        }),
      ],
      name,
    );
  const files = [
    make("state_10.npz"),
    make("state_2.npz"),
    new File(
      [
        JSON.stringify({
          frames: [
            { step: 2, time: 0.2 },
            { step: 10, time: 0.7 },
          ],
        }),
      ],
      "measurements.json",
    ),
  ];
  const source = new NPZSource("npz", files);
  await source.initialize(files);
  assert.deepEqual(source.times, [0.2, 0.7]);
  const meta = await source.metadata();
  assert.equal(meta.identity, "unavailable");
  assert.equal(meta.frames, 2);
  const raw = await source.read(0, "velocities");
  assert.equal(reduceDiagnostic(raw, 0, 0.2).kineticEnergy, 31);
  assert.equal(
    displayFrame(raw, 0, 0.2, "velocities").arrays.positions.data.length,
    4,
  );
  const withoutTime = new NPZSource("untimed", [files[0]]);
  await withoutTime.initialize([files[0]]);
  assert.equal(withoutTime.timeKind, "frame");
});
test("browser analytical sources have explicit sampling, time, identities and diagnostic decay", async () => {
  const demo = new DemoSource(3),
    meta = await demo.metadata();
  assert.equal(meta.dimension, 3);
  assert.equal(meta.frames, 121);
  assert.equal(meta.format, "Analytical demo");
  const first = reduceDiagnostic(demo.read(0), 0, 0),
    last = reduceDiagnostic(demo.read(120), 120, 6);
  assert.ok(first.kineticEnergy! > last.kineticEnergy!);
  assert.equal(first.particles, 5832);
});
test("browser diagnostics exclude boundaries and preserve missing quantities", () => {
  const f: RawFrame = {
    positions: { data: new Float32Array(6), shape: [3, 2] },
    kinds: { data: new Int32Array([0, 0, 1]), shape: [3] },
    velocities: {
      data: new Float64Array([3, 4, 0, 2, 100, 100]),
      shape: [3, 2],
    },
    masses: { data: new Float64Array([2, 3, 100]), shape: [3] },
    densities: { data: new Float64Array([1, 2, 100]), shape: [3] },
  };
  assert.deepEqual(reduceDiagnostic(f, 7, 0.2), {
    index: 7,
    time: 0.2,
    particles: 2,
    kineticEnergy: 31,
    maxSpeed: 5,
    meanDensity: 1.5,
  });
  delete f.masses;
  assert.equal(reduceDiagnostic(f, 0, 0).kineticEnergy, null);
  f.densities.data[0] = NaN;
  assert.equal(reduceDiagnostic(f, 0, 0).meanDensity, null);
});
test("HDF5 reader slices compressed stacked frames and reads stored diagnostics", async () => {
  await h5.ready;
  const dir = await mkdtemp(join(tmpdir(), "warpsph-browser-")),
    path = join(dir, "chunked.h5");
  try {
    const file = new h5.File(path, "w");
    const frames = file.create_group("frames"),
      particles = file.create_group("particles");
    frames.create_dataset({
      name: "positions",
      data: new Float32Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]),
      shape: [2, 3, 2],
      chunks: [1, 3, 2],
      compression: "gzip",
    });
    frames.create_dataset({
      name: "velocities",
      data: new Float32Array([3, 4, 0, 2, 100, 100, 6, 8, 0, 4, 100, 100]),
      shape: [2, 3, 2],
      chunks: [1, 3, 2],
      compression: "gzip",
    });
    frames.create_dataset({
      name: "densities",
      data: new Float32Array([1, 2, 50, 2, 4, 50]),
      shape: [2, 3],
    });
    particles.create_dataset({
      name: "kinds",
      data: new Int32Array([0, 0, 1]),
    });
    particles.create_dataset({
      name: "masses",
      data: new Float32Array([2, 3, 100]),
    });
    particles.create_dataset({
      name: "uids",
      data: new BigInt64Array([2n ** 54n + 1n, 2n, 3n]),
    });
    file.create_dataset({ name: "time", data: new Float64Array([0.2, 0.7]) });
    const domain = file.create_group("domain");
    domain.create_dataset({ name: "min", data: new Float64Array([0, -1]) });
    domain.create_dataset({ name: "max", data: new Float64Array([1, 1]) });
    domain.create_dataset({ name: "periodic", data: new Uint8Array([1, 0]) });
    const diag = file.create_group("diagnostics");
    for (const [name, data] of Object.entries({
      particles: [2, 2],
      kineticEnergy: [31, 124],
      maxSpeed: [5, 10],
      meanDensity: [1.5, 3],
    }))
      diag.create_dataset({ name, data: new Float64Array(data) });
    file.close();
    const source = new HDF5Source(
        "h5",
        "chunked.h5",
        new h5.File(path, "r"),
        h5,
      ),
      meta = await source.metadata();
    assert.deepEqual(meta.times, [0.2, 0.7]);
    assert.deepEqual(meta.domain, {
      min: [0, -1],
      max: [1, 1],
      periodic: [true, false],
    });
    const raw = source.read(1, "velocities");
    assert.deepEqual(raw.positions.shape, [3, 2]);
    assert.equal(raw.positions.data[0], 3);
    assert.equal(raw.UIDs.data[0], 2n ** 54n + 1n);
    assert.equal(reduceDiagnostic(raw, 1, 0.7).kineticEnergy, 124);
    assert.equal(source.recordedDiagnostic(1)?.meanDensity, 3);
    source.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HDF5 legacy columns retain dynamic densities and fail stale metadata after population change", async () => {
  await h5.ready;
  const dir = await mkdtemp(join(tmpdir(), "warpsph-browser-")),
    path = join(dir, "legacy.h5");
  try {
    const file = new h5.File(path, "w");
    for (const name of ["positions", "velocities", "densities", "times"])
      file.create_group(name);
    for (const [key, time, n] of [
      ["frame_2", 0.2, 3],
      ["frame_10", 0.7, 2],
    ] as const) {
      (file.get("positions") as h5.Group).create_dataset({
        name: key,
        data: new Float32Array(n * 2),
        shape: [n, 2],
      });
      (file.get("velocities") as h5.Group).create_dataset({
        name: key,
        data: new Float32Array(n * 2).fill(2),
        shape: [n, 2],
      });
      (file.get("densities") as h5.Group).create_dataset({
        name: key,
        data: new Float32Array(n).fill(1),
        shape: [n],
      });
      (file.get("times") as h5.Group).create_dataset({
        name: key,
        data: [time],
      });
    }
    file.create_dataset({
      name: "combinedKinds",
      data: new Int32Array([0, 0, 1]),
    });
    file.create_dataset({
      name: "combinedDensities",
      data: new Float32Array([999, 999, 999]),
    });
    const domain = file
      .create_group("config")
      .create_group("config")
      .create_group("domain");
    for (const [name, values] of Object.entries({
      min: [0, 0],
      max: [1, 1],
      periodic: [1, 1],
    })) {
      const group = domain.create_group(name);
      values.forEach((v, i) => group.create_attribute(`item_${i}`, v));
    }
    file.close();
    const source = new HDF5Source(
      "legacy",
      "legacy.h5",
      new h5.File(path, "r"),
      h5,
    );
    assert.deepEqual(source.times, [0.2, 0.7]);
    assert.deepEqual(source.domain, {
      min: [0, 0],
      max: [1, 1],
      periodic: [true, true],
    });
    assert.equal(source.read(0).densities.data[0], 1);
    assert.throws(() => source.read(1), /Particle count changed/);
    source.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
