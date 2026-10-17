import type { RawFrame } from "./core";
import { spatialDifference, type Domain } from "../spatial";
export interface MaterialSeed {
  index: number;
  time: number;
  uids: string[]; // center first; exact identities throughout
  positions: (number[] | null)[];
  fitCount: number; // excludes extra pinned seeds from the local deformation fit
  relative: (number[] | null)[]; // seed-time minimum-image branch
}
export interface MaterialSample {
  index: number;
  time: number;
  positions: (number[] | null)[];
}
export interface NeighbourSettings {
  mode: "nearest" | "radius" | "support";
  count: number;
  radius: number;
}
function exactID(value: number | bigint) {
  return typeof value === "bigint"
    ? String(value)
    : Number.isSafeInteger(value)
      ? String(value)
      : null;
}
/** A single frame scan resolves all identities; duplicate IDs are ambiguous and become gaps. */
export function materialPositions(
  raw: RawFrame,
  uids: string[],
): (number[] | null)[] {
  const positions = raw.positions,
    ids = raw.UIDs;
  if (!ids) throw new Error("Material tracking requires exact recorded UIDs.");
  const wanted = new Map(uids.map((uid, i) => [uid, i])),
    result: (number[] | null)[] = uids.map(() => null),
    seen = new Set<string>();
  for (let i = 0; i < positions.shape[0]; i++) {
    const uid = exactID(ids.data[i]);
    if (uid == null || !wanted.has(uid)) continue;
    const slot = wanted.get(uid)!;
    if (seen.has(uid)) {
      result[slot] = null;
      continue;
    }
    seen.add(uid);
    const point = Array.from({ length: positions.shape[1] }, (_, c) =>
      Number(positions.data[i * positions.shape[1] + c]),
    );
    if (point.every(Number.isFinite)) result[slot] = point;
  }
  return result;
}
export function seedMaterial(
  raw: RawFrame,
  uid: string,
  settings: NeighbourSettings,
  index: number,
  time: number,
  domain?: Domain,
  extra: string[] = [],
): MaterialSeed {
  if (
    !Number.isInteger(settings.count) ||
    settings.count < 1 ||
    settings.count > 64 ||
    !["nearest", "radius", "support"].includes(settings.mode) ||
    !Number.isFinite(settings.radius) ||
    settings.radius <= 0
  )
    throw new Error("Choose 1–64 neighbours and a positive finite radius.");
  const center = materialPositions(raw, [uid])[0];
  if (!center)
    throw new Error("The seed UID is absent or ambiguous at this frame.");
  const ids = raw.UIDs!,
    p = raw.positions,
    candidates: { uid: string; d: number }[] = [];
  let cutoff = settings.mode === "radius" ? settings.radius : Infinity;
  if (settings.mode === "support") {
    let row = -1;
    for (let i = 0; i < ids.data.length; i++)
      if (exactID(ids.data[i]) === uid) {
        row = i;
        break;
      }
    cutoff = Number(raw.supports?.data[row]);
    if (!(cutoff > 0 && Number.isFinite(cutoff)))
      throw new Error(
        "The selected particle has no valid cutoff support radius.",
      );
  }
  for (let i = 0; i < p.shape[0]; i++) {
    if (Number(raw.kinds.data[i]) !== 0) continue;
    const id = exactID(ids.data[i]);
    if (id == null || id === uid) continue;
    let d = 0;
    for (let c = 0; c < p.shape[1]; c++)
      d +=
        spatialDifference(
          Number(p.data[i * p.shape[1] + c]),
          center[c],
          c,
          domain,
        ) ** 2;
    if (d > 0 && d <= cutoff * cutoff) candidates.push({ uid: id, d });
  }
  candidates.sort((a, b) => a.d - b.d || a.uid.localeCompare(b.uid));
  const local = [
    ...new Set([uid, ...candidates.slice(0, settings.count).map((v) => v.uid)]),
  ];
  const uids = [...new Set([...local, ...extra])];
  if (uids.length > 73)
    throw new Error(
      "At most 64 neighbours and eight extra seeds are supported.",
    );
  const positions = materialPositions(raw, uids);
  return {
    index,
    time,
    uids,
    positions,
    fitCount: local.length,
    relative: positions.map(
      (point) =>
        point?.map((v, c) => spatialDifference(v, center[c], c, domain)) ??
        null,
    ),
  };
}
/** Keep the seed branch while preserving all subsequent unwrapped relative travel. */
export function relativeMaterial(seed: MaterialSeed, sample: MaterialSample) {
  const center = sample.positions[0],
    origin = seed.positions[0];
  return sample.positions.map((point, i) =>
    point && center && origin && seed.positions[i] && seed.relative[i]
      ? point.map(
          (v, c) =>
            v -
            center[c] -
            (seed.positions[i]![c] - origin[c]) +
            seed.relative[i]![c],
        )
      : null,
  );
}
export interface Deformation {
  ftle: number | null;
  condition: number | null;
  residual: number | null;
  neighbours: number;
  rmsSeparation: number | null;
  duration: number;
  direction: "forward" | "backward" | "seed";
  reason?: string;
  matrix?: number[];
  stretch?: number[];
}
/** 2D center-anchored uniform-weight least squares, independently validated against affine maps. */
export function deformation(
  seed: MaterialSeed,
  sample: MaterialSample,
  maxResidual = Infinity,
): Deformation {
  const current = relativeMaterial(seed, sample),
    dt = sample.time - seed.time;
  const out: Deformation = {
    ftle: null,
    condition: null,
    residual: null,
    neighbours: 0,
    rmsSeparation: null,
    duration: Math.abs(dt),
    direction: dt > 0 ? "forward" : dt < 0 ? "backward" : "seed",
  };
  if (seed.positions[0]?.length !== 2)
    return { ...out, reason: "Deformation fits currently support 2D." };
  let a = 0,
    b = 0,
    c = 0,
    h00 = 0,
    h01 = 0,
    h10 = 0,
    h11 = 0,
    sum = 0;
  const pairs: { x: number[]; y: number[] }[] = [];
  for (let i = 1; i < seed.fitCount; i++) {
    const x = seed.relative[i],
      y = current[i];
    if (!x || !y || !x.every(Number.isFinite) || !y.every(Number.isFinite))
      continue;
    a += x[0] * x[0];
    b += x[0] * x[1];
    c += x[1] * x[1];
    h00 += y[0] * x[0];
    h01 += y[0] * x[1];
    h10 += y[1] * x[0];
    h11 += y[1] * x[1];
    sum += y[0] ** 2 + y[1] ** 2;
    pairs.push({ x, y });
  }
  out.neighbours = pairs.length;
  if (pairs.length) out.rmsSeparation = Math.sqrt(sum / pairs.length);
  if (!sample.positions[0]) return { ...out, reason: "Center UID is absent." };
  if (pairs.length < 3)
    return {
      ...out,
      reason: "At least three matched neighbours are required.",
    };
  const hi = (a + c + Math.hypot(a - c, 2 * b)) / 2,
    det = a * c - b * b,
    lo = hi > 0 ? det / hi : 0;
  out.condition = lo > 0 ? hi / lo : null;
  if (!(lo > 0) || !out.condition || out.condition > 1e6)
    return {
      ...out,
      reason: "Initial neighbourhood is rank deficient or ill conditioned.",
    };
  const F = [
    (h00 * c - h01 * b) / det,
    (h01 * a - h00 * b) / det,
    (h10 * c - h11 * b) / det,
    (h11 * a - h10 * b) / det,
  ];
  let error = 0;
  for (const { x, y } of pairs)
    error +=
      (F[0] * x[0] + F[1] * x[1] - y[0]) ** 2 +
      (F[2] * x[0] + F[3] * x[1] - y[1]) ** 2;
  out.residual = Math.sqrt(error / Math.max(sum, Number.MIN_VALUE));
  out.matrix = F;
  const ca = F[0] ** 2 + F[2] ** 2,
    cb = F[0] * F[1] + F[2] * F[3],
    cc = F[1] ** 2 + F[3] ** 2,
    lmax = (ca + cc + Math.hypot(ca - cc, 2 * cb)) / 2,
    determinant = (F[0] * F[3] - F[1] * F[2]) ** 2;
  out.stretch = [
    Math.sqrt(lmax),
    Math.sqrt(lmax > 0 ? Math.max(0, determinant / lmax) : 0),
  ];
  if (out.residual > maxResidual)
    return { ...out, reason: `Relative fit residual exceeds ${maxResidual}.` };
  if (dt === 0)
    return { ...out, reason: "Choose a nonzero physical-time horizon." };
  if (!Number.isFinite(dt) || !(lmax > 0) || !Number.isFinite(lmax))
    return { ...out, reason: "Invalid time horizon or degenerate flow map." };
  out.ftle = Math.log(Math.sqrt(lmax)) / Math.abs(dt);
  return out;
}
