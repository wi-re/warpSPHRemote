export interface Measurement {
  sequence: number;
  wallTime: number;
  elapsedSeconds: number;
  time?: number;
  step?: number;
  status: string;
  physical?: Record<string, number | null>;
  performance?: Record<string, number>;
  resources?: {
    sampledAt?: number;
    processRamBytes?: number;
    systemRamUsedBytes?: number;
    systemRamTotalBytes?: number;
    gpus: Record<string, any>[];
  };
}
export function flattenMeasurement(
  row: Measurement,
): Record<string, number | null> {
  const out: Record<string, number | null> = {
    elapsedSeconds: row.elapsedSeconds,
    simulationTime: row.time ?? null,
    step: row.step ?? null,
  };
  for (const [key, v] of Object.entries(row.physical ?? {}))
    if (!["step", "time", "wallTime"].includes(key)) out[key] = v;
  for (const [key, v] of Object.entries(row.performance ?? {})) out[key] = v;
  const r = row.resources;
  if (r) {
    if (r.sampledAt !== undefined) out.resourceSampledAt = r.sampledAt;
    for (const key of [
      "processRamBytes",
      "systemRamUsedBytes",
      "systemRamTotalBytes",
    ] as const)
      if (r[key] !== undefined) out[key] = r[key]!;
    for (const gpu of r.gpus ?? [])
      for (const key of [
        "processVramBytes",
        "usedVramBytes",
        "totalVramBytes",
        "utilizationPercent",
        "powerWatts",
        "temperatureC",
      ])
        if (typeof gpu[key] === "number") out[`${gpu.uuid}.${key}`] = gpu[key];
  }
  return out;
}
export function measurementCSV(rows: Measurement[]) {
  const maps = rows.map(flattenMeasurement),
    keys = [...new Set(maps.flatMap((m) => Object.keys(m)))];
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    "sequence,wallTime,status," + keys.map(quote).join(","),
    ...maps.map((m, i) =>
      [
        rows[i].sequence,
        rows[i].wallTime,
        quote(rows[i].status),
        ...keys.map((k) => m[k] ?? ""),
      ].join(","),
    ),
  ].join("\n");
}
export function sampleSummary(rows: Measurement[], metric: string) {
  const values = rows
    .map(flattenMeasurement)
    .map((r) => r[metric])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const quantile = (p: number) => {
    const x = (values.length - 1) * p,
      lo = Math.floor(x),
      hi = Math.ceil(x);
    return values[lo] + (values[hi] - values[lo]) * (x - lo);
  };
  return values.length
    ? {
        count: values.length,
        min: values[0],
        max: values.at(-1)!,
        median: quantile(0.5),
        p95: quantile(0.95),
      }
    : null;
}

export function metricLabel(key: string) {
  const labels: Record<string, string> = {
    stepMs: "Step throughput [ms/step]",
    simulationRate: "Simulation time / active wall second",
    processRamBytes: "Process RAM [bytes]",
    systemRamUsedBytes: "System RAM used [bytes]",
    systemRamTotalBytes: "System RAM total [bytes]",
    processVramBytes: "Process VRAM [bytes]",
    usedVramBytes: "Device VRAM used [bytes]",
    totalVramBytes: "Device VRAM total [bytes]",
    utilizationPercent: "Device utilization [%]",
    powerWatts: "Device power [W]",
    temperatureC: "Device temperature [°C]",
    kineticEnergy: "Kinetic energy",
    internalEnergy: "Internal energy",
    totalEnergy: "Kinetic + internal energy",
    meanPressure: "Mean pressure",
    meanDensity: "Mean density",
    totalMass: "Total mass",
    captureMs: "State copy [ms]",
    encodeMs: "Encoding [ms]",
    publishMs: "Publication [ms]",
    captureBytes: "Captured state [bytes]",
    omittedSamples: "Omitted diagnostic samples",
  };
  const parts = key.split(".");
  const field = parts.at(-1)!;
  return (
    (parts.length > 1 ? "GPU " + parts[0].slice(-8) + " · " : "") +
    (labels[field] ?? key)
  );
}
