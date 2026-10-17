import type { Frame } from "../types";
import type { FieldMode } from "../FieldView";
import type { TrajectorySource } from "./client";
import { categoricalField, type FieldQuery, type FieldResult } from "./grid";

export interface Presentation {
  sourceId: string;
  frame: Frame;
  field: string;
  mode: FieldMode;
  result: FieldResult | null;
  key: string;
}

/** A display update is complete only when its requested derived data is ready.
 * Never publish a particle frame and later replace it with a grid for that frame.
 */
export async function loadPresentation(
  reader: Pick<TrajectorySource, "frame" | "grid"> & {
    metadata: { id: string };
  },
  index: number,
  field: string,
  mode: FieldMode,
  query: FieldQuery | null,
  key: string,
  signal: AbortSignal,
): Promise<Presentation> {
  signal.throwIfAborted();
  if (query && categoricalField(field))
    throw new Error(
      "Select a continuous scalar or vector quantity for reconstruction.",
    );
  if (query?.seed && query.seed.length !== 2)
    throw new Error(
      "Pick a particle to seed an instantaneous streamline, or choose regular seeds.",
    );
  // Enqueue together so low-priority history work cannot slip between the
  // particle read and reconstruction. The worker reuses its raw-frame cache.
  const [frame, result] = await Promise.all([
    reader.frame(index, field, signal),
    query ? reader.grid(query, signal) : Promise.resolve(null),
  ]);
  signal.throwIfAborted();
  return { sourceId: reader.metadata.id, frame, field, mode, result, key };
}
