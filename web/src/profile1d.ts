import { scalarValues } from "./data";
import { mappedCoordinate } from "./spatial";
import type { Frame, Source, ViewOptions } from "./types";
/** Physical x and signed scalar samples; never pad the source into another dimension. */
export function profileSamples(
  frame: Frame,
  source: Source,
  field: string,
  options: ViewOptions,
) {
  if (source.dimension !== 1 || frame.arrays.positions.shape[1] !== 1)
    throw new Error("A 1D profile requires N×1 positions.");
  const values = scalarValues(frame, field, options.mapping);
  return Array.from(values, (y, i) => ({
    i,
    x: mappedCoordinate(
      Number(frame.arrays.positions.data[i]),
      0,
      frame.domain ?? source.domain,
      options.wrapPeriodic,
    ),
    y,
    kind: Number(frame.arrays.kinds?.data[i] ?? 0),
  })).filter(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      (p.kind === 0 || (p.kind === 1 ? options.boundaries : options.ghosts)),
  );
}
export function finiteExtent(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Infinity,
    hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = Math.max(
    (hi - lo) * 0.06,
    Math.abs(lo) * (hi === lo ? 0.01 : 1e-6),
    1e-6,
  );
  return [lo - pad, hi + pad];
}
export function physicalEdges(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some(
      (a) => !Array.isArray(a) || a.length !== 1 || !Number.isFinite(a[0]),
    ) ||
    value[1][0] <= value[0][0]
  )
    return [];
  return [value[0][0], value[1][0]];
}

/** Preserve small differences on top of a large background in numerical axis labels. */
export function axisTick(value: number, span: number) {
  const step = Math.max(Math.abs(span) / 5, Number.MIN_VALUE);
  if (value !== 0 && (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-4)) {
    const digits = Math.max(
      2,
      Math.min(8, Math.ceil(Math.log10(Math.abs(value) / step)) + 1),
    );
    return value.toExponential(digits);
  }
  const digits = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step)) + 1));
  return String(Number(value.toFixed(digits)));
}
