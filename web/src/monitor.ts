import type { Simulation } from "./companion";

export function activeSimulation(run: Simulation) {
  return !run.stale && ["starting", "running", "paused"].includes(run.status);
}
const newest = (runs: Simulation[]) =>
  runs.reduce<Simulation | undefined>(
    (last, run) => (!last || run.startedAt >= last.startedAt ? run : last),
    undefined,
  );
/** Baseline once; keep delayed registrations pending instead of rediscovering them. */
export function discoverSimulations(
  runs: Simulation[],
  known: Set<string> | null,
  follow: boolean,
) {
  const fresh = known ? runs.filter((run) => !known.has(run.id)) : [];
  return {
    known: new Set(runs.map((run) => run.id)),
    notice: newest(fresh),
    follow: follow
      ? newest((known ? fresh : runs).filter(activeSimulation))
      : undefined,
  };
}
const key = "warpsph-companion-monitor-v1";
export function recallMonitor() {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}
export function rememberMonitor(enabled: boolean) {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    /* session remains usable */
  }
}
