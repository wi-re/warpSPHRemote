import { dimensionChoices, resolutionLimit } from "./launchParameters";
import type { Preset, Simulation } from "./companion";
import type { ParameterSchema } from "./ConfigurationFields";
export interface LaunchSettings {
  preset: string;
  scheme: string;
  variant: string;
  nx: number;
  duration: number;
  steps?: number | null;
  record: boolean;
  exportInterval: number;
  exportEverySteps?: number;
  paused?: boolean;
  measurements?: boolean;
  diagnosticInterval?: number;
  video?: { fps: number; interval: number; everySteps?: number };
  configuration?: {
    params?: Record<string, any>;
    solver?: Record<string, any>;
    simulation?: Record<string, any>;
  };
}
export interface RerunDraft {
  name: string;
  spec: LaunchSettings;
}
export const finishedRun = (run: Simulation) =>
  ["completed", "failed", "stopped", "interrupted"].includes(run.status);
export function rerunIssue(
  run: Simulation,
  presets: Preset[],
  features: string[],
): string | undefined {
  if (!finishedRun(run)) return "Wait until this simulation finishes.";
  const spec = run.launch;
  if (!spec)
    return "No saved launch request. Only daemon-launched runs can be run again here.";
  const entry = presets.find((p) => p.id === spec.preset);
  if (!entry || entry.available === false)
    return "This case is unavailable on the connected daemon.";
  if (!entry.schemes.includes(spec.scheme))
    return "The saved solver is unavailable for this case.";
  if (!Object.hasOwn(entry.variants, spec.variant))
    return "The saved case variant is unavailable.";
  const dimension = spec.configuration?.simulation?.dim ?? entry.dimension ?? 2;
  if (!dimensionChoices(entry).includes(dimension))
    return "The saved dimension is unavailable for this case.";
  if (
    !Number.isInteger(spec.nx) ||
    spec.nx < 8 ||
    spec.nx > resolutionLimit(entry, dimension)
  )
    return "The saved resolution is outside this daemon’s supported range.";
  if (
    !Number.isFinite(spec.duration) ||
    spec.duration < 1e-6 ||
    spec.duration > 10000
  )
    return "The saved end time is invalid.";
  if (spec.video && !features.includes("videoFromStart"))
    return "Update the companion to reuse video-from-start settings.";
  if (
    spec.exportEverySteps !== undefined &&
    !features.includes("recordingEstimates")
  )
    return "Update the companion to reuse step-based trajectory export.";
  if (spec.measurements && !features.includes("diagnosticRecording"))
    return "Update the companion to reuse diagnostic recording settings.";
}
export function rerunDraft(
  run: Simulation,
  presets: Preset[],
  features: string[],
): RerunDraft {
  const issue = rerunIssue(run, presets, features);
  if (issue) throw new Error(issue);
  // Copy only launch settings; never copy run IDs, leases, paths or process state.
  const s = run.launch!;
  const spec: LaunchSettings = {
    preset: s.preset,
    scheme: s.scheme,
    variant: s.variant,
    nx: s.nx,
    duration: s.duration,
    record: !!s.record,
    exportInterval: s.exportInterval ?? 0.05,
  };
  for (const k of [
    "steps",
    "exportEverySteps",
    "paused",
    "measurements",
    "diagnosticInterval",
    "video",
    "configuration",
  ] as const)
    if (s[k] !== undefined) (spec as any)[k] = structuredClone(s[k]);
  return { name: run.name, spec };
}
/** Never silently discard saved overrides that a changed schema cannot display. */
export function unsupportedOverrides(
  schema: ParameterSchema | undefined,
  values: Record<string, any>,
  path: string,
): string[] {
  return Object.entries(values).flatMap(([key, value]) => {
    const item = schema?.properties?.[key],
      name = path + "." + key;
    if (
      !item ||
      item.readOnly ||
      item["x-derived-from"] ||
      (item.enum && !item.enum.includes(value))
    )
      return [name];
    return item.type === "object" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
      ? unsupportedOverrides(item, value, name)
      : [];
  });
}
