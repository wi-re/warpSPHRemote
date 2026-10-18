import type { Simulation } from "./companion";

export interface FrameTransfer {
  bytes: number;
  staticBytes: number;
  durationMs: number;
  receivedAt: number;
  intervalMs?: number;
  totalBytes: number;
}
export interface GPUMetrics {
  uuid: string;
  name: string;
  processVramBytes?: number;
  usedVramBytes?: number;
  totalVramBytes?: number;
  utilizationPercent?: number;
  powerWatts?: number;
  temperatureC?: number;
}
export interface Resources {
  sampledAt: number;
  processRamBytes?: number;
  systemRamUsedBytes?: number;
  systemRamTotalBytes?: number;
  gpus: GPUMetrics[];
  gpuUnavailable?: string;
}
/** Forecast from recent active wall throughput, never the time spent paused. */
export function remainingSeconds(run: Simulation): number | undefined {
  if (["completed", "stopped", "failed"].includes(run.status)) return undefined;
  if (run.stale) return undefined;
  const p = run.performance;
  if (!p) return undefined;
  let seconds: number | undefined;
  if (p.targetStep !== undefined && run.step !== undefined && p.stepMs! > 0)
    seconds = (Math.max(0, p.targetStep - run.step) * p.stepMs!) / 1000;
  else if (
    p.targetTime !== undefined &&
    run.time !== undefined &&
    p.simulationRate! > 0
  )
    seconds = Math.max(0, p.targetTime - run.time) / p.simulationRate!;
  return seconds !== undefined && Number.isFinite(seconds)
    ? seconds
    : undefined;
}
export function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return "—";
  seconds = Math.ceil(seconds);
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
export const megabytes = (bytes: number | undefined, digits = 1) =>
  bytes === undefined ? "—" : `${(bytes / 1e6).toFixed(digits)} MB`;
export const transferRate = (transfer: FrameTransfer) =>
  transfer.durationMs > 0
    ? transfer.bytes / transfer.durationMs / 1000
    : undefined;

export const memorySize = (bytes: number | undefined) =>
  bytes === undefined
    ? "—"
    : bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(2)} GB`
      : megabytes(bytes);
