import { tracePosition, type TraceSample } from "./traces";
import {
  samplePressures,
  type PressureProbe,
  type ProbeSample,
} from "./probes";
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
  static async open(files: File[], demo?: 2 | 3): Promise<BrowserSource> {
    const source = new BrowserSource();
    try {
      source.metadata = await source.call(
        "open",
        { files, demo, sourceId: crypto.randomUUID() },
        0,
      );
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
  close() {
    this.fail(new DOMException("Recording closed", "AbortError"));
  }
}
export class ServiceSource implements TrajectorySource {
  constructor(public metadata: Source) {}
  async frame(index: number, field: string, signal?: AbortSignal) {
    const r = await fetch(
      `/api/sources/${this.metadata.id}/frames/${index}?field=${encodeURIComponent(field)}`,
      { signal },
    );
    if (!r.ok) throw new Error((await r.json()).error);
    return decodeFrame(await r.arrayBuffer());
  }
  diagnostics(start: number, count: number, signal?: AbortSignal) {
    return request<Diagnostic[]>(
      `/api/sources/${this.metadata.id}/diagnostics?start=${start}&count=${count}`,
      { signal },
    );
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
  close() {}
}
