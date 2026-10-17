import { computeLIC, initialLIC } from "../web/src/sources/lic";
import catalogue from "../web/src/recorded-demos.json";
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
    const named = process.argv.indexOf("--case"),
      selection = named >= 0 ? process.argv[named + 1] : undefined;
    const files = process.argv.includes("--khh")
      ? ["khh-crksph-256.h5"]
      : catalogue
          .filter(
            (d) =>
              (!process.argv.includes("--snapshots") ||
                ("group" in d && d.group === "snapshots")) &&
              (!selection || d.file === selection || d.id === selection),
          )
          .map((d) => d.file);
    if (!files.length) throw new Error("No matching recording was selected.");
    for (const filename of files) {
      const source = new HDF5Source(
        filename,
        filename,
        new api.File(`${process.cwd()}/web/public/demos/${filename}`, "r"),
        api,
      );
      try {
        for (const quantity of (process.argv.includes("--derivatives")
          ? ["divergence", "vorticity"]
          : ["field"]) as ("field" | "divergence" | "vorticity")[]) {
          for (const resolution of [128, 256, 512] as const) {
            const cpuTimes: number[] = [],
              gpuTimes: number[] = [];
            let worst = 0;
            const licCPU: number[] = [],
              licGPU: number[] = [];
            let licError = 0,
              licSquared = 0,
              licCells = 0,
              licLarge = 0;
            for (const index of [
              0,
              Math.floor(source.times.length / 2),
              source.times.length - 1,
            ]) {
              const raw = await source.read(index, "densities");
              raw.velocities = (
                await source.read(index, "velocities")
              ).velocities;
              const settings = { ...initialGrid, resolution, quantity };
              // Warm both paths for comparable medians; preserve first/last-frame parity checks.
              await gpu.reconstruct(
                raw,
                source,
                "densities",
                "magnitude",
                settings,
              );
              reconstructGrid(raw, source, "densities", "magnitude", settings);
              for (
                let repeat = 0;
                repeat < (process.argv.includes("--lic") ? 1 : 3);
                repeat++
              ) {
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
                if (process.argv.includes("--lic")) {
                  const time = performance.now(),
                    ref = computeLIC(actual, initialLIC);
                  licCPU.push(performance.now() - time);
                  const begun = performance.now(),
                    result = await gpu.lic(actual, initialLIC);
                  licGPU.push(performance.now() - begun);
                  for (let i = 0; i < result.length; i++) {
                    if (Number.isNaN(result[i]) && Number.isNaN(ref[i]))
                      continue;
                    if (!Number.isFinite(result[i]) || !Number.isFinite(ref[i]))
                      throw new Error(`LIC mask mismatch at ${i}`);
                    const error = Math.abs(result[i] - ref[i]);
                    licError = Math.max(licError, error);
                    licSquared += error * error;
                    licCells++;
                    if (error > 1e-3) licLarge++;
                  }
                  if (
                    licError > 0.05 ||
                    Math.sqrt(licSquared / licCells) > 0.001
                  )
                    throw new Error(
                      `LIC error max ${licError}, RMS ${Math.sqrt(licSquared / licCells)}`,
                    );
                }
              }
            }
            if (licCPU.length)
              report(
                `${filename} LIC ${resolution}: CPU median ${median(licCPU).toFixed(2)} ms; GPU complete median ${median(licGPU).toFixed(2)} ms; max absolute error ${licError.toExponential(3)}; RMS ${Math.sqrt(licSquared / licCells).toExponential(3)}; >1e-3 ${licLarge}/${licCells} cells (3 states)`,
              );
            report(
              `${filename} ${quantity} ${resolution}: CPU median ${median(cpuTimes).toFixed(2)} ms; GPU complete median ${median(gpuTimes).toFixed(2)} ms; max scaled error ${worst.toExponential(3)} (${process.argv.includes("--lic") ? 3 : 9} samples each)`,
            );
          }
        }
      } finally {
        source.close();
      }
    }
  } finally {
    gpu.close();
  }
}
