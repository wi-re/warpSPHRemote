export interface Domain {
  min: number[];
  max: number[];
  periodic: boolean[];
}
export function domainFrom(
  min: number[],
  max: number[],
  periodic: unknown[],
): Domain {
  if (
    ![2, 3].includes(min.length) ||
    max.length !== min.length ||
    periodic.length !== min.length ||
    periodic.some((v) => typeof v !== "boolean" && v !== 0 && v !== 1) ||
    min.some(
      (v, c) => !Number.isFinite(v) || !Number.isFinite(max[c]) || max[c] <= v,
    )
  )
    throw new Error(
      "Domain metadata must contain finite min/max bounds and periodic flags for each coordinate.",
    );
  return { min: [...min], max: [...max], periodic: periodic.map(Boolean) };
}
export function mappedCoordinate(
  value: number,
  c: number,
  domain?: Domain,
  wrap = true,
) {
  if (!wrap || !domain?.periodic[c]) return value;
  const lo = domain.min[c],
    length = domain.max[c] - lo;
  return lo + ((((value - lo) % length) + length) % length);
}
export function mappedPosition(
  position: number[],
  domain?: Domain,
  wrap = true,
) {
  return position.map((v, c) => mappedCoordinate(v, c, domain, wrap));
}
export function spatialDifference(
  a: number,
  b: number,
  c: number,
  domain?: Domain,
) {
  const delta = a - b;
  if (!domain?.periodic[c]) return delta;
  const length = domain.max[c] - domain.min[c];
  return delta - Math.round(delta / length) * length;
}
