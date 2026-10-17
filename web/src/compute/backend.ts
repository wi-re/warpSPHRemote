import { computeLIC, type LICSettings } from "../sources/lic";
import {
  reconstructGrid,
  type GridData,
  type GridSettings,
} from "../sources/grid";
import type { RawFrame } from "../sources/core";
import type { Mapping, Source } from "../types";
import type { GPUGrid } from "./webgpu";
/** One backend per source worker; initialization and failures are remembered. */
export class GridBackend {
  private gpu?: Promise<GPUGrid>;
  private failure = "";
  private tail: Promise<unknown> = Promise.resolve();
  reconstruct(
    raw: RawFrame,
    source: Pick<Source, "domain">,
    field: string,
    mapping: Mapping,
    settings: GridSettings,
    index = 0,
    time = 0,
    signal?: AbortSignal,
  ): Promise<GridData> {
    const job = this.tail.then(async () => {
      signal?.throwIfAborted();
      const grid = await this.run(
        raw,
        source,
        field,
        mapping,
        settings,
        index,
        time,
      );
      signal?.throwIfAborted();
      return grid;
    });
    this.tail = job.catch(() => {});
    return job;
  }
  private async run(
    raw: RawFrame,
    source: Pick<Source, "domain">,
    field: string,
    mapping: Mapping,
    settings: GridSettings,
    index = 0,
    time = 0,
  ): Promise<GridData> {
    const mode = settings.backend ?? "auto";
    if (mode !== "cpu" && !this.failure) {
      try {
        if (typeof navigator === "undefined" || !navigator.gpu) {
          this.failure = "WebGPU is unavailable in this browser or context.";
          throw new Error(this.failure);
        }
        this.gpu ??= import("./webgpu")
          .then((m) => m.GPUGrid.create())
          .catch((error) => {
            this.failure =
              error instanceof Error ? error.message : String(error);
            throw error;
          });
        return await (
          await this.gpu
        ).reconstruct(raw, source, field, mapping, settings, index, time);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A failed dataset must not permanently disable a working GPU for other frames/settings.
        if (
          !this.gpu ||
          /unavailable|adapter|device lost|destroyed/i.test(reason)
        )
          this.failure = reason;
        if (mode === "webgpu") throw new Error(`WebGPU: ${reason}`);
        return this.cpu(
          raw,
          source,
          field,
          mapping,
          settings,
          index,
          time,
          reason,
        );
      }
    }
    if (mode === "webgpu") throw new Error(`WebGPU: ${this.failure}`);
    return this.cpu(
      raw,
      source,
      field,
      mapping,
      settings,
      index,
      time,
      mode === "cpu" ? undefined : this.failure,
    );
  }
  private cpu(
    raw: RawFrame,
    source: Pick<Source, "domain">,
    field: string,
    mapping: Mapping,
    settings: GridSettings,
    index: number,
    time: number,
    reason?: string,
  ): GridData {
    const start = performance.now(),
      grid = reconstructGrid(
        raw,
        source,
        field,
        mapping,
        settings,
        index,
        time,
      );
    grid.compute = {
      backend: "cpu",
      milliseconds: performance.now() - start,
      reason,
    };
    return grid;
  }
  lic(
    grid: GridData,
    settings: LICSettings,
    mode: "auto" | "cpu" | "webgpu" = "auto",
  ) {
    const job = this.tail.then(async () => {
      const started = performance.now();
      let reason = "";
      if (mode !== "cpu" && this.gpu)
        try {
          return {
            values: await (await this.gpu).lic(grid, settings),
            backend: "webgpu" as const,
            milliseconds: performance.now() - started,
          };
        } catch (e) {
          reason = (e as Error).message;
          if (mode === "webgpu") throw e;
        }
      if (mode === "webgpu")
        throw new Error(
          "WebGPU LIC requires an available WebGPU reconstruction backend.",
        );
      return {
        values: computeLIC(grid, settings),
        backend: "cpu" as const,
        milliseconds: performance.now() - started,
        reason,
      };
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async close() {
    await this.tail;
    try {
      (await this.gpu)?.close();
    } catch {
      /* initialization failed */
    }
  }
}
