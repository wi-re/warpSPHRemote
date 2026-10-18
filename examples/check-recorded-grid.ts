/** Numerical parity on an extracted real frame; invoked by check-webgpu.mjs. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeFrame } from "../web/src/data";
import { initialGrid, reconstructGridAsync } from "../web/src/sources/grid";
import { GPUGrid } from "../web/src/compute/webgpu";
import { compare } from "../web/src/compute/checks";
import type { Source } from "../web/src/types";

export async function runChecks(report: (message: string) => void) {
  const fixture = process.argv[process.argv.indexOf("--fixture") + 1];
  if (!fixture)
    throw new Error(
      "Pass --fixture with a prepared numerical frame directory.",
    );
  const index = process.argv.indexOf("--resolution");
  const resolution = index < 0 ? 1024 : Number(process.argv[index + 1]);
  const bytes = await readFile(resolve(fixture, "frame.wpr1"));
  const frame = decodeFrame(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const source: Source = JSON.parse(
    await readFile(resolve(fixture, "metadata.json"), "utf8"),
  );
  const gpu = await GPUGrid.create();
  try {
    const settings = { ...initialGrid, resolution };
    const actual = await gpu.reconstruct(
      frame.arrays,
      source,
      "densities",
      "magnitude",
      settings,
    );
    const expected = await reconstructGridAsync(
      frame.arrays,
      source,
      "densities",
      "magnitude",
      settings,
    );
    const result = compare(actual, expected);
    report(
      JSON.stringify({
        particles: frame.arrays.positions.shape[0],
        resolution,
        width: actual.width,
        height: actual.height,
        adapter: gpu.adapter,
        gpuMilliseconds: actual.compute!.milliseconds,
        ...result,
      }),
    );
  } finally {
    gpu.close();
  }
}
