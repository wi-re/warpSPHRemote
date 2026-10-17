/** Drag up to increase. Horizontal distance and pointer speed accelerate changes. */
export function dragNumber(
  value: number,
  dy: number,
  dx: number,
  elapsed: number,
  step: number,
  min = -Infinity,
  max = Infinity,
  fine = false,
) {
  const speed = Math.abs(dy) / Math.max(16, elapsed);
  const gain =
    (1 + Math.min(12, Math.abs(dx) / 70)) *
    (1 + Math.min(3, speed) * 1.5) *
    (fine ? 0.1 : 1);
  const next = Math.max(min, Math.min(max, value - (dy * step * gain) / 8));
  return {
    accumulator: next,
    value: Number((Math.round(next / step) * step).toPrecision(12)),
  };
}
