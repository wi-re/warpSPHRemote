import { spatialDifference, type Domain } from "../spatial";
import type { RawFrame } from "./core";
export interface PressureProbe {
  id: string;
  name: string;
  position: number[];
  radius: number;
  method: "nearest" | "idw";
}
export interface ProbeSample {
  index: number;
  time: number;
  values: Record<string, number | null>;
}
/** Fixed spatial sampling in stored coordinates, using finite kind-0 values.
 * IDW is an approximate reconstruction, not the simulator's SPH kernel.
 * No neighbour within the radius, or no recorded pressure, yields a gap.
 */
export function samplePressures(
  frame: RawFrame,
  probes: PressureProbe[],
  domain?: Domain,
): Record<string, number | null> {
  const p = frame.positions,
    pressure = frame.pressures,
    kinds = frame.kinds;
  const dim = p?.shape[1],
    n = p?.shape[0];
  return Object.fromEntries(
    probes.map((probe) => {
      if (
        !p ||
        !pressure ||
        pressure.data.length !== n ||
        !Number.isFinite(probe.radius) ||
        probe.radius <= 0 ||
        probe.position.length !== dim ||
        !probe.position.every(Number.isFinite)
      )
        return [probe.id, null];
      let nearest = Infinity,
        nearestValue: number | null = null,
        numerator = 0,
        denominator = 0;
      // Scale IDW weights by radius² to avoid overflow for ordinary physical units.
      const radius2 = probe.radius * probe.radius;
      for (let i = 0; i < n; i++) {
        if (kinds && Number(kinds.data[i]) !== 0) continue;
        const value = Number(pressure.data[i]);
        if (!Number.isFinite(value)) continue;
        let d2 = 0;
        for (let c = 0; c < dim; c++)
          d2 +=
            spatialDifference(
              Number(p.data[i * dim + c]),
              probe.position[c],
              c,
              domain,
            ) ** 2;
        if (!Number.isFinite(d2) || d2 > radius2) continue;
        if (d2 === 0) {
          nearest = 0;
          nearestValue = value;
          break;
        }
        if (d2 < nearest) {
          nearest = d2;
          nearestValue = value;
        }
        if (probe.method === "idw") {
          const w = radius2 / d2;
          numerator += w * value;
          denominator += w;
        }
      }
      const value =
        probe.method === "nearest" || nearest === 0
          ? nearestValue
          : denominator > 0
            ? numerator / denominator
            : null;
      return [probe.id, value != null && Number.isFinite(value) ? value : null];
    }),
  );
}
/** Plot samples carry recorded indices; time spacing need not be uniform. */
export function clickedFrame(
  event: { points?: { customdata?: unknown }[] },
  frames: number,
): number | null {
  const i = event.points?.[0]?.customdata;
  return typeof i === "number" && Number.isInteger(i) && i >= 0 && i < frames
    ? i
    : null;
}

/** Recordings retain their entire history; live sampling may request a bound. */
export function mergeProbeSamples(
  previous: ProbeSample[],
  incoming: ProbeSample[],
  limit?: number,
): ProbeSample[] {
  const rows = [
    ...new Map(
      [...previous, ...incoming].map((row) => [row.index, row]),
    ).values(),
  ].sort((a, b) => a.index - b.index);
  return limit === undefined ? rows : rows.slice(-limit);
}
