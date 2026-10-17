import { GPUScan } from "./scan";
import { reconstructGrid, initialGrid, type GridData } from "../sources/grid";
import { GPUGrid } from "./webgpu";

import { fixture } from "./fixtures";
export function compare(a: GridData, b: GridData) {
  let worst = 0,
    cells = 0;
  for (const key of ["values", "velocity", "coverage"] as const) {
    if (a[key].length !== b[key].length)
      throw new Error(`${key}: shape mismatch`);
    for (let i = 0; i < a[key].length; i++) {
      const x = a[key][i],
        y = b[key][i];
      if (Number.isNaN(x) && Number.isNaN(y)) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new Error(`${key}[${i}]: mask mismatch (${x}, ${y})`);
      const error = Math.abs(x - y) / (1 + Math.abs(y));
      worst = Math.max(worst, error);
      cells++;
      if (error > 8e-5)
        throw new Error(
          `${key}[${i}]: relative-to-(1+|reference|) error ${error}`,
        );
    }
  }
  if (
    a.excluded !== b.excluded ||
    a.velocityValid.some((x, i) => x !== b.velocityValid[i])
  )
    throw new Error("Physical/velocity masks differ.");
  return { worst, cells };
}
async function checkScan(report: (row: string) => void) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No adapter for prefix-scan checks.");
  const device = await adapter.requestDevice(),
    scan = await GPUScan.create(device);
  try {
    for (const n of [1, 127, 128, 129, 16385, 262144]) {
      const buffers: GPUBuffer[] = [];
      const allocate = (_: string, size: number, usage: number) => {
        const b = device.createBuffer({ size: Math.max(4, size), usage });
        buffers.push(b);
        return b;
      };
      const input = Uint32Array.from({ length: n }, (_, i) =>
        i % 17 === 0 ? 0 : (i * 37) % 101,
      );
      const a = allocate(
          "input",
          n * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        ),
        b = allocate(
          "output",
          n * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        ),
        read = allocate(
          "read",
          n * 4,
          GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        );
      device.queue.writeBuffer(a, 0, input);
      const encoder = device.createCommandEncoder();
      scan.encode(encoder, a, b, n, allocate);
      encoder.copyBufferToBuffer(b, 0, read, 0, n * 4);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(read.getMappedRange());
      let sum = 0;
      for (let i = 0; i < n; i++) {
        if (values[i] !== sum)
          throw new Error(`Prefix scan ${n}[${i}] != ${sum}`);
        sum += input[i];
      }
      read.unmap();
      for (const buffer of buffers) buffer.destroy();
      report(`PASS exclusive scan: ${n} integers, exact offsets`);
    }
  } finally {
    device.destroy();
  }
}
export async function runChecks(report: (row: string) => void) {
  await checkScan(report);
  const gpu = await GPUGrid.create();
  report(`Adapter: ${gpu.adapter}`);
  let passed = 0;
  try {
    for (const kernel of ["wendland2", "wendland4"] as const)
      for (const resolution of [128, 256, 512] as const)
        for (const field of ["test", "velocities"]) {
          const raw = fixture(),
            source = {
              domain: { min: [0, 0], max: [1, 1], periodic: [true, true] },
            };
          const settings = { ...initialGrid, kernel, resolution };
          const cpu = reconstructGrid(
              raw,
              source,
              field,
              "magnitude",
              settings,
            ),
            actual = await gpu.reconstruct(
              raw,
              source,
              field,
              "magnitude",
              settings,
            );
          const result = compare(actual, cpu);
          passed++;
          report(
            `PASS ${kernel} ${resolution}² ${field}: ${result.cells} samples, max scaled error ${result.worst.toExponential(2)}, GPU end-to-end ${actual.compute!.milliseconds.toFixed(1)} ms`,
          );
        }
    for (const scenario of [
      "masked",
      "nonperiodic",
      "single-bin",
      "constant",
      "component",
      "no-velocity",
      "partial-periodic",
      "empty-fluid",
      "four-components",
    ] as const) {
      const raw = fixture(scenario === "single-bin" ? 1001 : 157);
      const source = {
        domain: {
          min: [0, 0],
          max: [1, 1],
          periodic: [scenario !== "nonperiodic", scenario !== "nonperiodic"],
        },
      };
      if (scenario === "masked") {
        raw.test.data[1] = NaN;
        raw.velocities.data[4] = NaN;
        raw.masses.data[3] = -1;
        raw.supports.data[4] = Infinity;
      }
      if (scenario === "single-bin") {
        (raw.supports.data as Float64Array).fill(2);
      }
      if (scenario === "constant") (raw.test.data as Float64Array).fill(2.5);
      if (scenario === "no-velocity") delete raw.velocities;
      if (scenario === "partial-periodic") source.domain.periodic[1] = false;
      if (scenario === "empty-fluid") (raw.kinds.data as Int32Array).fill(1);
      if (scenario === "four-components") {
        raw.test = {
          data: Float64Array.from({ length: 157 * 4 }, (_, i) => (i % 11) - 5),
          shape: [157, 4],
        };
      }
      const settings = { ...initialGrid, resolution: 128 as const },
        field = scenario === "component" ? "velocities" : "test",
        mapping = scenario === "component" ? "y" : "magnitude";
      const before = raw.positions.data.slice();
      const cpu = reconstructGrid(raw, source, field, mapping, settings),
        actual = await gpu.reconstruct(raw, source, field, mapping, settings);
      const result = compare(actual, cpu);
      if (raw.positions.data.some((x, i) => x !== before[i]))
        throw new Error("Source coordinates changed.");
      passed++;
      report(
        `PASS ${scenario}: max scaled error ${result.worst.toExponential(2)}`,
      );
    }
    report(`COMPLETE: ${passed} GPU/CPU parity cases passed.`);
  } finally {
    gpu.close();
  }
}
