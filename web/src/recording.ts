import type { ViewOptions } from "./types";
import type { FieldPreferences } from "./FieldView";
export type ViewportSettings =
  | {
      kind: "particles";
      position: number[];
      up: number[];
      target: number[];
      top: number;
      bottom: number;
      zoom: number;
      near: number;
      far: number;
    }
  | {
      kind: "profile";
      x: [number, number];
      y: [number, number];
      follow: boolean;
    };
export interface RecordingView {
  version: 1;
  sourceId: string;
  field: string;
  options: ViewOptions;
  fieldView: FieldPreferences;
  viewport: ViewportSettings;
  time: number;
}
const key = (id: string) => "warpsph-recording-view:" + id;
export function saveRecordingView(view: RecordingView) {
  const copy = structuredClone(view);
  try {
    localStorage.setItem(key(view.sourceId), JSON.stringify(copy));
  } catch {
    /* Session copy remains usable. */
  }
  return copy;
}
export function readRecordingView(id: string): RecordingView | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(id)) ?? "null");
    return v?.version === 1 &&
      v.sourceId === id &&
      typeof v.field === "string" &&
      v.options &&
      v.fieldView &&
      ["particles", "profile"].includes(v.viewport?.kind)
      ? v
      : null;
  } catch {
    return null;
  }
}
/** Includes both the first frame and a final frame when the cadence misses it. */
export function captureCount(
  start: number,
  end: number,
  stride: number,
): number | undefined {
  if (
    ![start, end, stride].every(Number.isFinite) ||
    end < start ||
    stride <= 0
  )
    return undefined;
  return Math.ceil((end - start) / stride - 1e-9) + 1;
}
export function videoPlan(
  fps: number,
  start: number,
  end: number | undefined,
  stride: number,
  estimated = false,
) {
  const frames =
    end === undefined ? undefined : captureCount(start, end, stride);
  return {
    frames,
    seconds: frames === undefined || fps <= 0 ? undefined : frames / fps,
    estimated,
  };
}
export function videoPlanText(plan: ReturnType<typeof videoPlan>): string {
  if (plan.frames === undefined || plan.seconds === undefined)
    return "Frame count and video duration need a known end time or step limit.";
  return `${plan.estimated ? "Estimated " : ""}${plan.frames.toLocaleString()} frames · ${plan.seconds.toFixed(2)} s of video`;
}
export function validCadence(
  fps: number,
  interval: number,
  everySteps?: number,
) {
  return (
    Number.isInteger(fps) &&
    fps >= 1 &&
    fps <= 120 &&
    Number.isFinite(interval) &&
    interval >= 1e-6 &&
    interval <= 10000 &&
    (everySteps === undefined ||
      (Number.isInteger(everySteps) && everySteps >= 1 && everySteps <= 1e9))
  );
}
