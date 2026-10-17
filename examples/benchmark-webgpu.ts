import { GPUGrid } from "../web/src/compute/webgpu";
import { compare } from "../web/src/compute/checks";
import { HDF5Source } from "../web/src/sources/hdf5";
import { reconstructGrid, initialGrid } from "../web/src/sources/grid";
import type * as H5 from "h5wasm";
/** HDF5 decoding is deliberately outside timed reconstruction. No simulation runtime needed. */
export async function runChecks(report: (row: string) => void, api: typeof H5) {
  const gpu = await GPUGrid.create();
  report(`Adapter: ${gpu.adapter}`);
  const median = (a: number[]) =>
    a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  try {
    for (const filename of ["random-wcsph-128.h5", "sloshing-200.h5"]) {
      const source = new HDF5Source(
        filename,
        filename,
        new api.File(`${process.cwd()}/web/public/demos/${filename}`, "r"),
        api,
      );
      try {
        for (const resolution of [128, 256, 512] as const) {
          const cpuTimes: number[] = [],
            gpuTimes: number[] = [];
          let worst = 0;
          for (const index of [
            0,
            Math.floor(source.times.length / 2),
            source.times.length - 1,
          ]) {
            const raw = await source.read(index, "densities");
            raw.velocities = (
              await source.read(index, "velocities")
            ).velocities;
            const settings = { ...initialGrid, resolution };
            // Warm both paths for comparable medians; preserve first/last-frame parity checks.
            await gpu.reconstruct(
              raw,
              source,
              "densities",
              "magnitude",
              settings,
            );
            reconstructGrid(raw, source, "densities", "magnitude", settings);
            for (let repeat = 0; repeat < 3; repeat++) {
              const started = performance.now(),
                cpu = reconstructGrid(
                  raw,
                  source,
                  "densities",
                  "magnitude",
                  settings,
                );
              cpuTimes.push(performance.now() - started);
              const actual = await gpu.reconstruct(
                raw,
                source,
                "densities",
                "magnitude",
                settings,
              );
              gpuTimes.push(actual.compute!.milliseconds);
              worst = Math.max(worst, compare(actual, cpu).worst);
            }
          }
          report(
            `${filename} ${resolution}: CPU median ${median(cpuTimes).toFixed(2)} ms; GPU complete median ${median(gpuTimes).toFixed(2)} ms; max scaled error ${worst.toExponential(3)} (9 samples each)`,
          );
        }
      } finally {
        source.close();
      }
    }
  } finally {
    gpu.close();
  }
}
