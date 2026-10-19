import type { Simulation } from "./companion";
import { finishedRun } from "./rerun";
/** A registered interrupted producer may still be recovering; the daemon owns the final check. */
export function canForgetRun(run: Simulation): boolean {
  return finishedRun(run) && !(run.status === "interrupted" && run.registered);
}
/** Operate on the reviewed list only, stopping on error with successful removals retained. */
export async function clearFinishedHistory(
  runs: Simulation[],
  forget: (id: string) => Promise<void>,
  onForgot: (id: string, completed: number, total: number) => void,
): Promise<number> {
  const ids = runs.filter(canForgetRun).map((run) => run.id);
  let completed = 0;
  for (const id of ids) {
    try {
      await forget(id);
    } catch (error) {
      throw new Error(
        `Cleared ${completed} of ${ids.length} finished runs. Remaining entries were kept. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onForgot(id, ++completed, ids.length);
  }
  return completed;
}
