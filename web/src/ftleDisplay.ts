import type { FTLEBatch } from "./sources/ftle";

/** Presentation-only counts. Masked samples are not interpreted as zero FTLE. */
export function ftleSummary(result: FTLEBatch, maxResidual: number) {
  const total = result.width * result.height;
  const processed = Math.min(total, result.offset);
  const counts = {
    valid: 0,
    noParticle: 0,
    fewMatches: 0,
    residual: 0,
    unavailable: 0,
  };
  const values: number[] = [];
  for (let i = 0; i < processed; i++) {
    if (Number.isFinite(result.values[i])) {
      counts.valid++;
      values.push(result.values[i]);
    } else if (result.uids[i] == null) counts.noParticle++;
    else if (result.counts[i] < 3) counts.fewMatches++;
    else if (
      Number.isFinite(result.residual[i]) &&
      result.residual[i] > maxResidual
    )
      counts.residual++;
    else counts.unavailable++;
  }
  values.sort((a, b) => a - b);
  return {
    ...counts,
    total,
    processed,
    pending: total - processed,
    masked: processed - counts.valid,
    min: values[0] ?? 0,
    max: values.at(-1) ?? 1,
    p95: values[Math.floor(Math.max(0, values.length - 1) * 0.95)] ?? 1,
  };
}
