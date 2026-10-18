import type { Simulation } from "./companion";

export interface FrameTransfer {
  bytes: number;
  step?: number;
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
    : bytes < 1e6
      ? `${(bytes / 1e3).toFixed(1)} KB`
      : bytes >= 1e9
        ? `${(bytes / 1e9).toFixed(2)} GB`
        : megabytes(bytes);

const solverLabels: Record<string, string> = {
  initializing: "Initializing the simulation",
  running: "Integrating simulation steps",
  paused: "Paused by user",
  video_viewer: "Waiting for video viewer to reconnect",
  video_frame: "Waiting for video frame render / encode acknowledgement",
};
const captureLabels: Record<string, string> = {
  idle: "Idle",
  copying: "Copying state to CPU",
  queued: "Owned CPU frame queued",
  configuration: "Publishing configuration",
  history: "Reading recorded history",
  encoding: "Encoding frame on adapter",
  publishing: "Sending frame to daemon",
  transfers_paused: "Transfers paused; solver can continue",
  not_attached: "No live viewer attached",
  awaiting_ack: "Waiting for viewer to finish the current frame",
  capture_interval: "Waiting for capture interval",
  next_step: "Waiting for next safe simulation boundary",
};
export const solverActivity = (value?: string) =>
  value ? (solverLabels[value] ?? value) : "Adapter stage unavailable";
export const captureActivity = (value?: string) =>
  value ? (captureLabels[value] ?? value) : "Adapter stage unavailable";
export function limitingStage(
  run: Simulation | undefined,
  transfer: FrameTransfer | undefined,
  prepareMs?: number,
  renderMs?: number,
  encodeMs?: number,
) {
  if (!run) return "Waiting for run status.";
  if (run.pipeline?.solver === "paused")
    return "Solver is paused. Transfers and inspection can still run.";
  if (run.pipeline?.solver === "video_viewer")
    return "Video is holding the solver until a viewer reconnects.";
  const p = run.performance;
  const stages: [string, number | undefined][] = [
    ["CPU state copy", p?.captureMs],
    ["adapter encoding", p?.encodeMs],
    ["adapter → daemon", p?.publishMs],
    ["frame download", transfer?.durationMs],
    ["frame preparation / reconstruction", prepareMs],
    ["viewport rendering", renderMs],
    ["video encoding", encodeMs],
  ];
  const slow = stages
    .filter((s): s is [string, number] => s[1] !== undefined && s[1] > 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (!slow) return "Waiting for first frame timings.";
  return `Largest measured frame stage: ${slow[0]} (${slow[1].toFixed(1)} ms). ${run.video?.active ? "Video synchronization can hold the solver for frame delivery." : "This limits live updates; background transfer does not hold the solver."}`;
}
