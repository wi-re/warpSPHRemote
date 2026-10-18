import { useEffect, useMemo, useState } from "react";
import type { SimulationControl } from "./companion";
import {
  duration,
  solverActivity,
  captureActivity,
  limitingStage,
  megabytes,
  memorySize,
  remainingSeconds,
  transferRate,
} from "./liveMetrics";
import { NumberControl } from "./NumberControl";
import { formatNumber } from "./data";

export function LiveMetrics({
  control,
  viewer,
}: {
  control: SimulationControl;
  viewer?: {
    reconstructing: boolean;
    encoding: boolean;
    renderMs: number;
    prepareMs?: number;
    encodeMs?: number;
  };
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { run, transfer } = control;
  const p = run?.performance,
    resources = run?.resources;
  const remaining = run ? remainingSeconds(run) : undefined;
  const paused = control.pauseRequested || control.status === "paused";
  const rate = transfer && transferRate(transfer);
  // Host and browser clocks need not agree. Anchor forecasts to local receipt.
  const forecastAt = useMemo(
    () =>
      remaining === undefined
        ? undefined
        : (control.observedAt ?? Date.now()) + remaining * 1000,
    [remaining, control.observedAt],
  );
  const staleResources =
    resources &&
    run &&
    (run.updatedAt - resources.sampledAt) * 1000 +
      now -
      (control.observedAt ?? now) >
      10000;
  return (
    <section
      className="inspector-section live-metrics"
      aria-label="Live simulation performance"
    >
      <div className="section-heading">LIVE PERFORMANCE</div>
      <dl className="properties">
        <dt>Status</dt>
        <dd>{run?.stale ? "Heartbeat overdue" : control.status}</dd>
        <dt>Solver activity</dt>
        <dd>
          {["completed", "stopped", "failed"].includes(control.status)
            ? `Run ${control.status}`
            : solverActivity(run?.pipeline?.solver)}
          {run?.pipeline ? ` · ${run.pipeline.solverSeconds.toFixed(1)} s` : ""}
        </dd>
        <dt>Capture pipeline</dt>
        <dd>{captureActivity(run?.pipeline?.capture)}</dd>
        <dt>Viewer activity</dt>
        <dd>
          {run?.video?.armed
            ? "Initial view ready · waiting for Start video"
            : viewer?.encoding
              ? "Encoding video frame"
              : viewer?.reconstructing
                ? "Preparing / reconstructing frame"
                : control.viewerStage === "downloading"
                  ? "Requesting / downloading frame"
                  : control.viewerStage === "rendering"
                    ? "Rendering frame / waiting for acknowledgement"
                    : "Waiting for next snapshot"}
        </dd>
        <dt>Current step</dt>
        <dd>{run?.step?.toLocaleString() ?? "—"}</dd>
        <dt>Simulation time</dt>
        <dd>{run?.time !== undefined ? formatNumber(run.time, 5) : "—"}</dd>
        <dt>Time step Δt</dt>
        <dd>{run?.dt !== undefined ? formatNumber(run.dt, 5) : "—"}</dd>
        <dt>Live updates</dt>
        <dd>
          {control.transfersPaused
            ? "Paused · solver independent"
            : "Following snapshots"}
        </dd>
        <dt title="Rolling completed-step wall throughput, including simulation output overhead; deliberate pauses excluded.">
          Wall time / step
        </dt>
        <dd>{p?.stepMs !== undefined ? `${p.stepMs.toFixed(2)} ms` : "—"}</dd>
        <dt>Remaining estimate</dt>
        <dd>
          {duration(remaining)}
          {paused && remaining !== undefined ? " · paused" : ""}
        </dd>
        <dt>Estimated finish</dt>
        <dd>
          {remaining !== undefined && !paused
            ? new Date(forecastAt!).toLocaleTimeString()
            : "—"}
        </dd>
        <dt title="Interval between complete frame downloads; includes capture, rendering backpressure and polling.">
          Between updates
        </dt>
        <dd>
          {transfer?.intervalMs !== undefined
            ? `${(transfer.intervalMs / 1000).toFixed(2)} s`
            : "—"}
        </dd>
        <dt>Last update</dt>
        <dd>
          {transfer
            ? `${Math.max(0, (now - transfer.receivedAt) / 1000).toFixed(0)} s ago`
            : "—"}
        </dd>
      </dl>
      <p className="subtle-note" role="status">
        {limitingStage(
          run,
          transfer,
          viewer?.prepareMs,
          viewer?.renderMs,
          viewer?.encodeMs,
        )}
      </p>
      {run?.video?.active && (
        <p className="subtle-note">
          Synchronized video holds the solver until frames are rendered. Step
          throughput and ETA exclude deliberate capture holds.
        </p>
      )}
      <details className="live-metrics-detail" open>
        <summary>Frame transfer</summary>
        <dl className="properties">
          <dt title="Time spent preserving an owned CPU copy at a completed simulation step, including GPU-to-CPU synchronization.">
            State → CPU copy
          </dt>
          <dd>
            {p?.captureMs !== undefined ? `${p.captureMs.toFixed(1)} ms` : "—"}
          </dd>
          <dt title="Validation, hashing and packet encoding on the transfer worker; the simulation does not wait for this.">
            Background encoding
          </dt>
          <dd>
            {p?.encodeMs !== undefined ? `${p.encodeMs.toFixed(1)} ms` : "—"}
          </dd>
          <dt>Daemon frame buffer</dt>
          <dd>
            {run?.frameBuffer?.ready
              ? `${memorySize(run.frameBuffer.bytes)} ready · ${run.frameBuffer.ageSeconds.toFixed(1)} s`
              : "Waiting for capture / next frame"}
          </dd>
          <dt>Adapter → daemon</dt>
          <dd>
            {p?.publishMs !== undefined ? `${p.publishMs.toFixed(1)} ms` : "—"}
          </dd>
          <dt>Frame preparation</dt>
          <dd>{viewer?.prepareMs?.toFixed(1) ?? "—"} ms</dd>
          <dt>Viewport draw</dt>
          <dd>{viewer?.renderMs?.toFixed(1) ?? "—"} ms</dd>
          <dt>Video encoding</dt>
          <dd>{viewer?.encodeMs?.toFixed(1) ?? "—"} ms</dd>
          <dt>Owned CPU state</dt>
          <dd>{memorySize(p?.captureBytes)}</dd>
          <dt title="How far the simulation has advanced beyond the last downloaded snapshot.">
            Steps since snapshot
          </dt>
          <dd>
            {run?.step !== undefined && transfer?.step !== undefined
              ? Math.max(0, run.step - transfer.step).toLocaleString()
              : "—"}
          </dd>
          <dt>Downloaded</dt>
          <dd>{megabytes(transfer?.bytes, 3)}</dd>
          <dt title="Full response bodies, including any newly fetched static identity data; excludes decoding and rendering.">
            Download time
          </dt>
          <dd>{transfer ? `${transfer.durationMs.toFixed(1)} ms` : "—"}</dd>
          <dt title="Payload MB / end-to-end request seconds, including server latency. HTTP headers excluded.">
            Effective rate
          </dt>
          <dd>{rate !== undefined ? `${rate.toFixed(1)} MB/s` : "—"}</dd>
          <dt>Static data fetched</dt>
          <dd>{megabytes(transfer?.staticBytes, 3)}</dd>
          <dt>This attachment</dt>
          <dd>{megabytes(transfer?.totalBytes, 3)}</dd>
        </dl>
        <label className="live-capture-interval">
          Minimum capture interval (s)
          <NumberControl
            aria-label="Minimum capture interval"
            value={control.captureInterval ?? 0.5}
            min={0}
            step={0.1}
            disabled={
              !control.canSetCaptureInterval || !!control.run?.video?.active
            }
            onValueChange={(value) => control.setCaptureInterval?.(value)}
          />
        </label>
        <p className="subtle-note">
          A CPU copy is captured after acknowledgement, subject to this minimum
          interval. Zero adds no interval. Encoding and transfer run in the
          background.
        </p>
      </details>
      {run?.storageEstimate && (
        <details className="live-metrics-detail" open>
          <summary>Trajectory storage estimate</summary>
          <dl className="properties">
            <dt>Export cadence</dt>
            <dd>
              Every {run.storageEstimate.everySteps.toLocaleString()} steps
            </dd>
            <dt>Expected frames</dt>
            <dd>
              {run.storageEstimate.estimated ? "≈ " : ""}
              {run.storageEstimate.frames?.toLocaleString() ?? "Unknown"}
            </dd>
            <dt>Per frame (raw + overhead)</dt>
            <dd>{memorySize(run.storageEstimate.bytesPerFrame)}</dd>
            <dt>Estimated trajectory</dt>
            <dd>≈ {memorySize(run.storageEstimate.totalBytes)}</dd>
          </dl>
          <p className="subtle-note">
            Based on initialized particle arrays and exported fields, with HDF5
            overhead. Includes an allowance for initial data; separate
            checkpoints/configuration, changing particle counts and rigid bodies
            can add storage.{" "}
            {run.storageEstimate.estimated
              ? "Frame count projects the remaining steps using current Δt; adaptive time steps can change it."
              : "Frame count follows the configured step limit."}
          </p>
        </details>
      )}
      <details className="live-metrics-detail" open>
        <summary>Simulation hardware{staleResources ? " · stale" : ""}</summary>
        <dl className="properties">
          <dt>Process RAM</dt>
          <dd>{memorySize(resources?.processRamBytes)}</dd>
          <dt>System RAM used</dt>
          <dd>{memorySize(resources?.systemRamUsedBytes)}</dd>
          <dt>System RAM total</dt>
          <dd>{memorySize(resources?.systemRamTotalBytes)}</dd>
        </dl>
        {resources?.gpus.map((gpu) => (
          <div key={gpu.uuid}>
            <p className="subtle-note">{gpu.name}</p>
            <dl className="properties">
              <dt>Process VRAM</dt>
              <dd>{memorySize(gpu.processVramBytes)}</dd>
              <dt>GPU VRAM used</dt>
              <dd>{memorySize(gpu.usedVramBytes)}</dd>
              <dt>GPU VRAM total</dt>
              <dd>{memorySize(gpu.totalVramBytes)}</dd>
              <dt>GPU utilization</dt>
              <dd>
                {gpu.utilizationPercent !== undefined
                  ? `${gpu.utilizationPercent.toFixed(0)}%`
                  : "—"}
              </dd>
              <dt>GPU power</dt>
              <dd>
                {gpu.powerWatts !== undefined
                  ? `${gpu.powerWatts.toFixed(1)} W`
                  : "—"}
              </dd>
              <dt>GPU temperature</dt>
              <dd>
                {gpu.temperatureC !== undefined
                  ? `${gpu.temperatureC.toFixed(0)} °C`
                  : "—"}
              </dd>
            </dl>
          </div>
        ))}
        <p className="subtle-note">
          {resources?.gpuUnavailable ??
            (resources?.gpus.length
              ? "GPU load, power and temperature cover the whole device."
              : "Hardware counters require an updated simulation adapter.")}
        </p>
      </details>
    </section>
  );
}
