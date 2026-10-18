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
  warning?: string;
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
  const categorical = !!query && categoricalField(query.field);
  const continuousQuery = categorical
    ? query!.streams
      ? {
          ...query!,
          field: "velocities",
          mapping: "magnitude" as const,
          lic: undefined,
        }
      : null
    : query;
  // Picked-position mode can be enabled before a particle is selected. Keep
  // rendering the field (and LIC), but do not substitute regular streamlines.
  const reconstruction =
    continuousQuery?.seed &&
    (continuousQuery.seed.length !== 2 ||
      !continuousQuery.seed.every(Number.isFinite))
      ? { ...continuousQuery, streams: null, seed: undefined }
      : continuousQuery;
  // Enqueue together so low-priority history work cannot slip between the
  // particle read and reconstruction. The worker reuses its raw-frame cache.
  let warning: string | undefined;
  const [frame, result] = await Promise.all([
    reader.frame(index, field, signal),
    reconstruction
      ? reader.grid(reconstruction, signal).catch((error: unknown) => {
          signal.throwIfAborted();
          warning = error instanceof Error ? error.message : String(error);
          return null;
        })
      : Promise.resolve(null),
  ]);
  signal.throwIfAborted();
  return {
    sourceId: reader.metadata.id,
    frame,
    field,
    mode: categorical || warning ? "particles" : mode,
    result,
    key,
    ...(warning ? { warning } : {}),
  };
}
