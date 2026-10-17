import type { RawFrame } from "./core";
import { mappedPosition, type Domain } from "../spatial";
export interface TraceSample {
  index: number;
  time: number;
  position: number[] | null;
}
export function tracePosition(frame: RawFrame, uid: string): number[] | null {
  const ids = frame.UIDs,
    p = frame.positions;
  if (!ids || !p) return null;
  let wanted: bigint;
  try {
    wanted = BigInt(uid);
  } catch {
    return null;
  }
  for (let i = 0; i < ids.data.length; i++) {
    const value = ids.data[i];
    if (
      (typeof value === "bigint"
        ? value
        : Number.isSafeInteger(value)
          ? BigInt(value)
          : null) !== wanted
    )
      continue;
    const position = Array.from({ length: p.shape[1] }, (_, c) =>
      Number(p.data[i * p.shape[1] + c]),
    );
    return position.every(Number.isFinite) ? position : null;
  }
  return null;
}
/** No interpolation across absent IDs or periodic seams. Original positions stay unwrapped. */
export function traceSegments(
  rows: TraceSample[],
  current: number,
  domain?: Domain,
  wrap = true,
) {
  const past: number[] = [],
    future: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1],
      b = rows[i];
    if (!a.position || !b.position || b.index !== a.index + 1) continue;
    if (
      wrap &&
      domain?.periodic.some(
        (enabled, c) =>
          enabled &&
          Math.floor(
            (a.position![c] - domain.min[c]) / (domain.max[c] - domain.min[c]),
          ) !==
            Math.floor(
              (b.position![c] - domain.min[c]) /
                (domain.max[c] - domain.min[c]),
            ),
      )
    )
      continue;
    const target = b.index <= current ? past : future;
    for (const point of [a.position, b.position])
      target.push(...[...mappedPosition(point, domain, wrap), 0].slice(0, 3));
  }
  return { past, future };
}
