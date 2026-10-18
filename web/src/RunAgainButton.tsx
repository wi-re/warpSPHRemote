import { RotateCcw } from "lucide-react";
import type { Preset, Simulation } from "./companion";
import { finishedRun, rerunIssue } from "./rerun";
export function RunAgainButton({
  run,
  presets,
  features,
  busy,
  onRunAgain,
}: {
  run: Simulation;
  presets: Preset[];
  features: string[];
  busy?: boolean;
  onRunAgain: (run: Simulation) => void;
}) {
  if (!finishedRun(run)) return null;
  const issue = rerunIssue(run, presets, features);
  return (
    <button
      className="secondary-button"
      disabled={busy || !!issue}
      title={
        issue ?? "Review the previous launch settings before starting a new run"
      }
      onClick={() => onRunAgain(run)}
    >
      <RotateCcw size={13} /> Run again
    </button>
  );
}
