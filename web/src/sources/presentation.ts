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
  if (query && categoricalField(query.field))
    throw new Error(
      "Select a continuous scalar or vector quantity for reconstruction.",
    );
  // Picked-position mode can be enabled before a particle is selected. Keep
  // rendering the field (and LIC), but do not substitute regular streamlines.
  const reconstruction =
    query?.seed &&
    (query.seed.length !== 2 || !query.seed.every(Number.isFinite))
      ? { ...query, streams: null, seed: undefined }
      : query;
  // Enqueue together so low-priority history work cannot slip between the
  // particle read and reconstruction. The worker reuses its raw-frame cache.
  const [frame, result] = await Promise.all([
    reader.frame(index, field, signal),
    reconstruction
      ? reader.grid(reconstruction, signal)
      : Promise.resolve(null),
  ]);
  signal.throwIfAborted();
  return { sourceId: reader.metadata.id, frame, field, mode, result, key };
}
