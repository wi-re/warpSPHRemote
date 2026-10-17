/** Reduce exact integer UIDs before float32 upload so large IDs retain their phase. */
export function periodicColorValue(value: number | bigint, period: number) {
  if (!(Number.isInteger(period) && period >= 1 && period <= 1e9)) return NaN;
  if (typeof value === "bigint") {
    const p = BigInt(period);
    return Number(((value % p) + p) % p);
  }
  return ((value % period) + period) % period;
}
