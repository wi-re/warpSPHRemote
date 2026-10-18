import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRaw,
  displayFrame,
  reduceDiagnostic,
  type RawFrame,
} from "../web/src/sources/core";
import {
  profileSamples,
  finiteExtent,
  physicalEdges,
} from "../web/src/profile1d";
import { domainFrom } from "../web/src/spatial";
import { initialOptions, type Source } from "../web/src/types";
import {
  flattenMeasurement,
  measurementCSV,
  sampleSummary,
  type Measurement,
} from "../web/src/runMeasurements";

test("native 1D profiles preserve signed samples, identity, periodic mapping and compressing geometry", () => {
  const raw: RawFrame = {
    positions: { data: new Float64Array([0.95, 1.02, 0.4]), shape: [3, 1] },
    velocities: { data: new Float64Array([-2, 3, 99]), shape: [3, 1] },
    UIDs: { data: new BigInt64Array([2n ** 54n + 1n, 9n, 10n]), shape: [3] },
    kinds: { data: new Int32Array([0, 0, 1]), shape: [3] },
  };
  validateRaw(raw);
  const frame = displayFrame(raw, 0, 0.2, "velocities");
  frame.physicalBounds = [[0.2], [0.5]];
  const source = {
    dimension: 1,
    domain: domainFrom([0], [1], [true]),
  } as Source;
  const points = profileSamples(frame, source, "velocities", {
    ...initialOptions,
    boundaries: false,
  });
  assert.equal(points.length, 2);
  assert.equal(points[0].y, -2);
  assert.ok(Math.abs(points[1].x - 0.02) < 1e-6);
  assert.equal(frame.arrays.UIDs.data[0], 2n ** 54n + 1n);
  assert.deepEqual(physicalEdges(frame.physicalBounds), [0.2, 0.5]);
  assert.deepEqual(physicalEdges([[1], [0]]), []);
  assert.ok(finiteExtent([1, 1])[0] < 1);
  assert.equal(frame.arrays.positions.shape[1], 1);
});
test("post-run telemetry distinguishes process/device counters and preserves gaps in CSV", () => {
  const rows: Measurement[] = [
    {
      sequence: 1,
      wallTime: 1,
      elapsedSeconds: 0,
      time: 0,
      status: "running",
      performance: { stepMs: 20 },
      resources: {
        processRamBytes: 100,
        gpus: [
          { uuid: "gpu-a", processVramBytes: 500, utilizationPercent: 70 },
        ],
      },
    },
    {
      sequence: 2,
      wallTime: 2,
      elapsedSeconds: 1,
      time: 0.2,
      status: "sampled",
      physical: { kineticEnergy: 3, "probe:p": null },
    },
    {
      sequence: 3,
      wallTime: 3,
      elapsedSeconds: 2,
      time: 0.3,
      status: "running",
      performance: { stepMs: 30 },
    },
  ];
  const flat = flattenMeasurement(rows[0]);
  assert.equal(flat["gpu-a.processVramBytes"], 500);
  assert.equal(flat["gpu-a.utilizationPercent"], 70);
  assert.equal(flat.processRamBytes, 100);
  assert.equal(flat.kineticEnergy, undefined);
  const csv = measurementCSV(rows);
  assert.ok(csv.includes('"probe:p"'));
  assert.equal(csv.split("\n").length, 4);
  assert.equal(sampleSummary(rows, "stepMs")?.count, 2);
  assert.equal(sampleSummary(rows, "stepMs")?.max, 30);
  assert.equal(sampleSummary(rows, "stepMs")?.median, 25);
  assert.equal(sampleSummary(rows, "stepMs")?.p95, 29.5);
});

test("the browser-only 1D compression fixture retains identity while its physical domain shrinks", async () => {
  const { DemoSource } = await import("../web/src/sources/core");
  const s = new DemoSource(1),
    metadata = await s.metadata();
  const first = s.read(0),
    last = s.read(80);
  assert.equal(metadata.dimension, 1);
  assert.equal(last.positions.shape[1], 1);
  assert.equal(last.UIDs.data[0], first.UIDs.data[0]);
  assert.ok(
    Number(last.positions.data[0]) < Number(first.positions.data[0]) * 0.61,
  );
  assert.deepEqual(s.frameMetadata(0).physicalBounds, [[0.9], [1]]);
  assert.ok(Math.abs(s.frameMetadata(80).physicalBounds![1][0] - 0.6) < 1e-12);
  assert.ok(Number(last.velocities.data[0]) < 0);
});
