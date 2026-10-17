import {
  histogram,
  scalarSamples,
  spatialSpectrum,
  type AnalysisQuery,
  type AnalysisResult,
} from "./analysis";
import { MaterialFTLE, type FTLEQuery, type FTLEBatch } from "./ftle";
import {
  seedMaterial,
  materialPositions,
  type MaterialSeed,
  type MaterialSample,
  type NeighbourSettings,
} from "./material";
import { GridBackend } from "../compute/backend";
import { streamlines, type FieldQuery, type FieldResult } from "./grid";
import { tracePosition, type TraceSample } from "./traces";
import {
  samplePressures,
  type PressureProbe,
  type ProbeSample,
} from "./probes";
import { reduceDiagnostic } from "./core";
import { decodeFrame, request } from "../data";
import type { Diagnostic, Frame, Source } from "../types";
export interface TrajectorySource {
  metadata: Source;
  frame(index: number, field: string, signal?: AbortSignal): Promise<Frame>;
  diagnostics(
    start: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[]>;
  probes(
    start: number,
    count: number,
    probes: PressureProbe[],
    signal?: AbortSignal,
  ): Promise<ProbeSample[]>;
  trace(
    start: number,
    count: number,
    uid: string,
    signal?: AbortSignal,
  ): Promise<TraceSample[]>;
  materialSeed(
    index: number,
    uid: string,
    settings: NeighbourSettings,
    extra: string[],
    signal?: AbortSignal,
  ): Promise<MaterialSeed>;
  material(
    start: number,
    count: number,
    uids: string[],
    signal?: AbortSignal,
  ): Promise<MaterialSample[]>;
  ftle(
    query: FTLEQuery,
    offset: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<FTLEBatch>;
  grid(query: FieldQuery, signal?: AbortSignal): Promise<FieldResult>;
  analyze(query: AnalysisQuery, signal?: AbortSignal): Promise<AnalysisResult>;
  close(): void;
}
interface Job {
  id: number;
  operation: string;
  args: unknown;
  priority: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  cleanup: () => void;
}
export class BrowserSource implements TrajectorySource {
  metadata!: Source;
  private worker = new Worker(new URL("./reader.worker.ts", import.meta.url), {
    type: "module",
  });
  private queue: Job[] = [];
  private current?: Job;
  private sequence = 0;
  private closed = false;
  private constructor() {
    this.worker.onmessage = (event) => {
      const job = this.current;
      if (!job || job.id !== event.data.id) return;
      job.cleanup();
      if (!job.signal?.aborted) {
        if (event.data.error) job.reject(new Error(event.data.error));
        else job.resolve(event.data.result);
      }
      this.current = undefined;
      this.pump();
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "The file reader worker failed."));
    };
  }
  static async open(
    files: File[],
    demo?: 2 | 3,
    sourceId: string = crypto.randomUUID(),
  ): Promise<BrowserSource> {
    const source = new BrowserSource();
    try {
      source.metadata = await source.call("open", { files, demo, sourceId }, 0);
      return source;
    } catch (e) {
      source.close();
      throw e;
    }
  }
  private call<T>(
    operation: string,
    args: unknown,
    priority: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("This recording has been closed."));
    if (signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        operation,
        args,
        priority,
        resolve,
        reject,
        signal,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) this.queue.splice(i, 1);
        job.cleanup();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.pump();
    });
  }
  private pump() {
    if (this.current || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.worker.postMessage({
      id: job.id,
      operation: job.operation,
      args: job.args,
    });
  }
  private fail(error: Error) {
    this.current?.cleanup();
    this.current?.reject(error);
    for (const job of this.queue) {
      job.cleanup();
      job.reject(error);
    }
    this.queue = [];
    this.current = undefined;
    this.closed = true;
    this.worker.terminate();
  }
  frame(index: number, field: string, signal?: AbortSignal) {
    return this.call<Frame>("frame", { index, field }, 1, signal);
  }
  diagnostics(start: number, count: number, signal?: AbortSignal) {
    return this.call<Diagnostic[]>("diagnostics", { start, count }, 2, signal);
  }
  probes(
    start: number,
    count: number,
    probes: PressureProbe[],
    signal?: AbortSignal,
  ) {
    return this.call<ProbeSample[]>(
      "probes",
      { start, count, probes },
      count === 1 ? 1 : 3,
      signal,
    );
  }
  trace(start: number, count: number, uid: string, signal?: AbortSignal) {
    return this.call<TraceSample[]>("trace", { start, count, uid }, 3, signal);
  }
  materialSeed(
    index: number,
    uid: string,
    settings: NeighbourSettings,
    extra: string[],
    signal?: AbortSignal,
  ) {
    return this.call<MaterialSeed>(
      "materialSeed",
      { index, uid, settings, extra },
      1,
      signal,
    );
  }
  material(start: number, count: number, uids: string[], signal?: AbortSignal) {
    return this.call<MaterialSample[]>(
      "material",
      { start, count, uids },
      3,
      signal,
    );
  }
  ftle(query: FTLEQuery, offset: number, count: number, signal?: AbortSignal) {
    return this.call<FTLEBatch>("ftle", { query, offset, count }, 3, signal);
  }
  analyze(query: AnalysisQuery, signal?: AbortSignal) {
    return this.call<AnalysisResult>("analysis", query, 2, signal);
  }
  grid(query: FieldQuery, signal?: AbortSignal) {
    return this.call<FieldResult>("grid", query, 1, signal);
  }
  close() {
    this.fail(new DOMException("Recording closed", "AbortError"));
  }
}
export class ServiceSource implements TrajectorySource {
  private gridBackend = new GridBackend();
  private ftleCache?: { key: string; context: MaterialFTLE };
  constructor(public metadata: Source) {}
  async frame(index: number, field: string, signal?: AbortSignal) {
    const r = await fetch(
      `/api/sources/${this.metadata.id}/frames/${index}?field=${encodeURIComponent(field)}`,
      { signal },
    );
    if (!r.ok) throw new Error((await r.json()).error);
    return decodeFrame(await r.arrayBuffer());
  }
  async diagnostics(start: number, count: number, signal?: AbortSignal) {
    const rows = await request<Diagnostic[]>(
      `/api/sources/${this.metadata.id}/diagnostics?start=${start}&count=${count}`,
      { signal },
    );
    const result: Diagnostic[] = [];
    for (const row of rows) {
      signal?.throwIfAborted();
      const frame = await this.frame(row.index, "velocities", signal);
      if (this.metadata.fields.some((f) => f.name === "pressures"))
        frame.arrays.pressures = (
          await this.frame(row.index, "pressures", signal)
        ).arrays.pressures;
      result.push({
        ...reduceDiagnostic(frame.arrays, row.index, row.time),
        ...row,
      });
    }
    return result;
  }
  async probes(
    start: number,
    count: number,
    probes: PressureProbe[],
    signal?: AbortSignal,
  ) {
    const rows: ProbeSample[] = [];
    for (
      let i = start;
      i < Math.min(start + count, this.metadata.frames);
      i++
    ) {
      const frame = await this.frame(i, "pressures", signal);
      rows.push({
        index: i,
        time: frame.time,
        values: samplePressures(frame.arrays, probes, this.metadata.domain),
      });
    }
    return rows;
  }
  async trace(start: number, count: number, uid: string, signal?: AbortSignal) {
    const rows: TraceSample[] = [];
    for (
      let i = start;
      i < Math.min(start + count, this.metadata.frames);
      i++
    ) {
      const frame = await this.frame(i, "UIDs", signal);
      rows.push({
        index: i,
        time: frame.time,
        position: tracePosition(frame.arrays, uid),
      });
    }
    return rows;
  }
  async materialSeed(
    index: number,
    uid: string,
    settings: NeighbourSettings,
    extra: string[],
    signal?: AbortSignal,
  ) {
    const frame = await this.frame(index, "UIDs", signal);
    return seedMaterial(
      frame.arrays,
      uid,
      settings,
      index,
      frame.time,
      this.metadata.domain,
      extra,
    );
  }
  async material(
    start: number,
    count: number,
    uids: string[],
    signal?: AbortSignal,
  ) {
    const rows: MaterialSample[] = [];
    for (
      let index = start;
      index < Math.min(start + count, this.metadata.frames);
      index++
    ) {
      signal?.throwIfAborted();
      const frame = await this.frame(index, "UIDs", signal);
      rows.push({
        index,
        time: frame.time,
        positions: materialPositions(frame.arrays, uids),
      });
    }
    return rows;
  }
  async ftle(
    query: FTLEQuery,
    offset: number,
    count: number,
    signal?: AbortSignal,
  ) {
    if (this.metadata.timeKind !== "simulation")
      throw new Error("FTLE requires recorded physical times.");
    const key = JSON.stringify(query);
    if (this.ftleCache?.key !== key) {
      const a = await this.frame(query.start, "UIDs", signal),
        b = await this.frame(query.end, "UIDs", signal);
      signal?.throwIfAborted();
      this.ftleCache = {
        key,
        context: new MaterialFTLE(
          a.arrays,
          b.arrays,
          query,
          a.time,
          b.time,
          this.metadata.domain,
        ),
      };
    }
    return this.ftleCache.context.batch(offset, count);
  }
  async grid(query: FieldQuery, signal?: AbortSignal): Promise<FieldResult> {
    const frame = await this.frame(query.index, query.field, signal);
    if (
      query.field !== "velocities" &&
      this.metadata.fields.some((f) => f.name === "velocities")
    )
      frame.arrays.velocities = (
        await this.frame(query.index, "velocities", signal)
      ).arrays.velocities;
    const grid = await this.gridBackend.reconstruct(
      frame.arrays,
      this.metadata,
      query.field,
      query.mapping,
      query.settings,
      query.index,
      frame.time,
      signal,
    );
    return {
      grid,
      lic: query.lic
        ? await this.gridBackend.lic(grid, query.lic, query.settings.backend)
        : undefined,
      field: query.field,
      mapping: query.mapping,
      sourceId: this.metadata.id,
      lines: query.streams
        ? streamlines(
            grid,
            query.streams,
            query.seed ? [query.seed] : undefined,
          )
        : new Float32Array(),
    };
  }
  async analyze(
    query: AnalysisQuery,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const frame = await this.frame(query.index, query.field, signal),
      grid = query.grid
        ? (await this.grid(query.grid, signal)).grid
        : undefined;
    const result =
      query.kind === "histogram"
        ? histogram(
            grid?.values ??
              scalarSamples(frame.arrays, query.field, query.mapping),
            query.bins,
          )
        : spatialSpectrum(grid!, query);
    return {
      ...result,
      index: query.index,
      time: frame.time,
      field:
        query.grid?.settings.quantity &&
        query.grid.settings.quantity !== "field"
          ? query.grid.settings.quantity
          : query.field,
    };
  }
  close() {
    this.ftleCache = undefined;
    void this.gridBackend.close();
  }
}
