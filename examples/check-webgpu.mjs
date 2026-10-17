/** Run the exact worker kernels through Dawn without a browser. Evidence stays outside Git. */
import { build } from "esbuild";
import { create, globals } from "webgpu";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
const outfile = resolve(tmpdir(), `warpsph-gpu-check-${process.pid}.mjs`);
await build({
  entryPoints: [
    process.argv.includes("--recordings")
      ? "examples/benchmark-webgpu.ts"
      : "web/src/compute/checks.ts",
  ],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "wgsl",
      setup(b) {
        b.onResolve({ filter: /\.wgsl\?raw$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "wgsl",
        }));
        b.onLoad({ filter: /.*/, namespace: "wgsl" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, "navigator", {
  value: {
    gpu: create(
      process.env.DAWN_BACKEND ? [`backend=${process.env.DAWN_BACKEND}`] : [],
    ),
  },
  configurable: true,
});
try {
  let api;
  if (process.argv.includes("--recordings")) {
    api = await import("h5wasm/node");
    await api.ready;
  }
  await (await import(pathToFileURL(outfile))).runChecks(console.log, api);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  delete globalThis.navigator;
}
