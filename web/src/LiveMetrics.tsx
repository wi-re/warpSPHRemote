import { useEffect, useMemo, useState } from "react";
import type { SimulationControl } from "./companion";
import {
  duration,
  megabytes,
  memorySize,
  remainingSeconds,
  transferRate,
} from "./liveMetrics";
import { formatNumber } from "./data";

export function LiveMetrics({ control }: { control: SimulationControl }) {
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
        <dt>Current step</dt>
        <dd>{run?.step?.toLocaleString() ?? "—"}</dd>
        <dt>Simulation time</dt>
        <dd>{run?.time !== undefined ? formatNumber(run.time, 5) : "—"}</dd>
        <dt>Time step Δt</dt>
        <dd>{run?.dt !== undefined ? formatNumber(run.dt, 5) : "—"}</dd>
        <dt title="Rolling completed-step wall throughput, including simulation output overhead; deliberate pauses excluded.">
          Time / step
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
      <details className="live-metrics-detail" open>
        <summary>Frame transfer</summary>
        <dl className="properties">
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
      </details>
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
