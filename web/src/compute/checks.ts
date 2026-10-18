import { computeLIC, initialLIC } from "../sources/lic";
import { GPUScan } from "./scan";
import { reconstructGrid, initialGrid, type GridData } from "../sources/grid";
import { GPUGrid } from "./webgpu";

import { fixture, velocityFixture, velocityDomain } from "./fixtures";
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
      if (
        error >
        (key === "values" &&
        (a.quantity === "divergence" || a.quantity === "vorticity")
          ? 3e-4
          : 8e-5)
      )
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
      for (const resolution of [128, 173, 256, 512] as const)
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
    for (const kernel of ["wendland2", "wendland4"] as const) {
      for (const resolution of [128, 173, 256, 512] as const)
        for (const quantity of ["divergence", "vorticity"] as const) {
          const raw = fixture(),
            source = {
              domain: { min: [0, 0], max: [1, 1], periodic: [true, true] },
            },
            settings = { ...initialGrid, kernel, resolution, quantity };
          const cpu = reconstructGrid(
              raw,
              source,
              "velocities",
              "magnitude",
              settings,
            ),
            actual = await gpu.reconstruct(
              raw,
              source,
              "velocities",
              "magnitude",
              settings,
            ),
            result = compare(actual, cpu);
          passed++;
          report(
            `PASS ${kernel} ${resolution}² ${quantity}: max scaled error ${result.worst.toExponential(2)}`,
          );
        }
      for (const [name, velocity, div, curl] of [
        ["translation", () => [1e6, -2e6], 0, 0],
        ["expansion", (x: number, y: number) => [2 * x, 3 * y], 5, 0],
        ["rotation", (x: number, y: number) => [-2 * y, 2 * x], 0, 4],
        ["shear", (_x: number, y: number) => [y, 0], 0, -1],
      ] as const)
        for (const [quantity, expected] of [
          ["divergence", div],
          ["vorticity", curl],
        ] as const) {
          const raw = velocityFixture(velocity),
            settings = {
              ...initialGrid,
              resolution: 128 as const,
              kernel,
              quantity,
            },
            cpu = reconstructGrid(
              raw,
              velocityDomain,
              "velocities",
              "magnitude",
              settings,
            ),
            actual = await gpu.reconstruct(
              raw,
              velocityDomain,
              "velocities",
              "magnitude",
              settings,
            ),
            result = compare(actual, cpu);
          for (let y = 40; y < 88; y++)
            for (let x = 40; x < 88; x++)
              if (
                Math.abs(actual.values[y * 128 + x] - expected) >
                (name === "translation" ? 1e-8 : 0.015)
              )
                throw new Error(`${name} analytic ${quantity} mismatch`);
          passed++;
          report(
            `PASS ${kernel} ${name} ${quantity}: max scaled error ${result.worst.toExponential(2)}`,
          );
        }
      for (const scenario of [
        "invalid-velocity",
        "invalid-field",
        "partial-periodic",
      ] as const)
        for (const quantity of ["divergence", "vorticity"] as const) {
          const raw = fixture(),
            source = {
              domain: {
                min: [0, 0],
                max: [1, 1],
                periodic: [true, scenario !== "partial-periodic"],
              },
            };
          if (scenario === "invalid-velocity") raw.velocities.data[2] = NaN;
          if (scenario === "invalid-field") raw.test.data[2] = NaN;
          const settings = {
              ...initialGrid,
              resolution: 128 as const,
              kernel,
              quantity,
            },
            cpu = reconstructGrid(raw, source, "test", "magnitude", settings),
            actual = await gpu.reconstruct(
              raw,
              source,
              "test",
              "magnitude",
              settings,
            ),
            result = compare(actual, cpu);
          passed++;
          report(
            `PASS ${kernel} ${scenario} ${quantity}: max scaled error ${result.worst.toExponential(2)}`,
          );
        }
    }
    for (const scenario of [
      "uniform",
      "rotation",
      "masked",
      "stagnant",
      "nonperiodic",
    ]) {
      const n = 64,
        count = n * n,
        grid: GridData = {
          index: 0,
          time: 0,
          width: n,
          height: n,
          bounds: [
            [0, 0],
            [1, 1],
          ],
          periodic: [scenario !== "nonperiodic", scenario !== "nonperiodic"],
          values: new Float32Array(count).fill(1),
          velocity: new Float32Array(count * 2),
          velocityValid: new Uint8Array(count).fill(1),
          coverage: new Float32Array(count).fill(1),
          excluded: 0,
        };
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          grid.velocity[2 * i] =
            scenario === "rotation"
              ? -(y + 0.5 - n / 2) / n
              : scenario === "stagnant"
                ? 0
                : 1;
          grid.velocity[2 * i + 1] =
            scenario === "rotation" ? (x + 0.5 - n / 2) / n : 0;
          if (scenario === "masked" && x >= 30 && x <= 34)
            grid.velocityValid[i] = 0;
        }
      const expected = computeLIC(grid, initialLIC),
        actual = await gpu.lic(grid, initialLIC);
      let worst = 0;
      for (let i = 0; i < count; i++) {
        if (Number.isNaN(actual[i]) && Number.isNaN(expected[i])) continue;
        if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i]))
          throw new Error(`LIC ${scenario}: mask mismatch at ${i}`);
        worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
      }
      if (worst > 2e-4)
        throw new Error(`LIC ${scenario}: max absolute error ${worst}`);
      passed++;
      report(
        `PASS LIC ${scenario}: max absolute error ${worst.toExponential(2)}`,
      );
    }
    // This valid all-to-all dataset exceeds the former total candidate cap.
    // Constant fields/velocities give an independent oracle without a costly CPU sum.
    for (const quantity of ["field", "divergence", "vorticity"] as const) {
      const raw = fixture(257);
      (raw.supports.data as Float64Array).fill(2);
      (raw.test.data as Float64Array).fill(2.5);
      for (let i = 0; i < 257; i++) {
        raw.velocities.data[2 * i] = 0.1;
        raw.velocities.data[2 * i + 1] = 0.2;
      }
      const source = {
        domain: { min: [0, 0], max: [1, 1], periodic: [true, true] },
      };
      const result = await gpu.reconstruct(raw, source, "test", "magnitude", {
        ...initialGrid,
        resolution: 1024,
        quantity,
      });
      const expected = quantity === "field" ? 2.5 : 0;
      for (let i = 0; i < result.values.length; i++) {
        if (
          !Number.isFinite(result.values[i]) ||
          Math.abs(result.values[i] - expected) > 3e-4
        )
          throw new Error(`Batched ${quantity}: incorrect cell ${i}`);
      }
      passed++;
      report(
        `PASS large batched ${quantity}: ${result.values.length} cells above former 160M candidate cap`,
      );
    }
    // Abort after submission begins, then use the same device again.
    const abort = new AbortController(),
      cancelledRaw = fixture(257);
    (cancelledRaw.supports.data as Float64Array).fill(2);
    const cancelTimer = setTimeout(() => abort.abort(), 0);
    try {
      await gpu.reconstruct(
        cancelledRaw,
        { domain: { min: [0, 0], max: [1, 1], periodic: [true, true] } },
        "test",
        "magnitude",
        { ...initialGrid, resolution: 1024 },
        0,
        0,
        abort.signal,
      );
      throw new Error("Aborted GPU job executed");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    } finally {
      clearTimeout(cancelTimer);
    }
    const reusable = await gpu.reconstruct(
      fixture(),
      { domain: { min: [0, 0], max: [1, 1], periodic: [true, true] } },
      "test",
      "magnitude",
      initialGrid,
    );
    if (reusable.width !== initialGrid.resolution)
      throw new Error("Device reuse after cancellation failed");
    passed++;
    report("PASS in-flight cancellation and device reuse");
    report(`COMPLETE: ${passed} GPU/CPU parity cases passed.`);
  } finally {
    gpu.close();
  }
}
