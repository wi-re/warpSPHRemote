import type { Frame } from "../types";
export interface ParticleSelection {
  sourceId: string;
  frame: number;
  index: number;
  uid?: string;
}
/** Follow exact recorded identity, never silently keep an old row after reordering. */
export function selectionIndex(
  selection: ParticleSelection | null,
  sourceId: string,
  frame: Frame | null,
) {
  if (!selection || selection.sourceId !== sourceId || !frame) return -1;
  if (selection.uid != null)
    return (
      frame.arrays.UIDs?.data.findIndex(
        (uid) => String(uid) === selection.uid,
      ) ?? -1
    );
  return selection.frame === frame.index &&
    selection.index >= 0 &&
    selection.index < frame.arrays.positions.shape[0]
    ? selection.index
    : -1;
}
