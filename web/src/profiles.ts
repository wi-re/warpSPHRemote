import type { Frame } from "./types";
import type { Domain } from "./spatial";
import { mappedCoordinate } from "./spatial";
export type ProfileCoordinate = "x" | "y" | "z" | "radius" | "angle";
export type ProfileComponent =
  "magnitude" | "x" | "y" | "z" | "radial" | "tangential";
export interface ProfileSettings {
  id: string;
  field: string;
  coordinate: ProfileCoordinate;
  component: ProfileComponent;
  center: number[];
  mode: "scatter" | "binned";
  bins: number;
  weight: "count" | "mass" | "volume";
  selection: "fluid" | "all" | "kind" | "material";
  materialField: string;
  material: number;
  sector: boolean;
  angleMin: number;
  angleMax: number;
  kind: number;
  sliceAxis: number;
  sliceMin: number;
  sliceMax: number;
  wrap: boolean;
  xlog: boolean;
  ylog: boolean;
}
export interface ProfileResult {
  x: number[];
  y: number[];
  uid: (string | null)[];
  indices: number[];
  spread: number[];
  counts: number[];
  accepted: number;
  omitted: number;
  sampled: boolean;
}
export function newProfile(
  field = "densities",
  center = [0, 0, 0],
): ProfileSettings {
  return {
    id: crypto.randomUUID(),
    field,
    coordinate: "x",
    component: "magnitude",
    center,
    mode: "scatter",
    bins: 64,
    weight: "count",
    selection: "fluid",
    kind: 0,
    materialField: "materials",
    material: 0,
    sector: false,
    angleMin: -Math.PI,
    angleMax: Math.PI,
    sliceAxis: -1,
    sliceMin: 0,
    sliceMax: 1,
    wrap: true,
    xlog: false,
    ylog: false,
  };
}
/** Scatter collapses coordinates without averaging. Bins use weighted mean and population stddev. */
export function profile(
  frame: Frame,
  s: ProfileSettings,
  domain?: Domain,
  limit = 30000,
): ProfileResult {
  const p = frame.arrays.positions,
    q = frame.arrays[s.field];
  if (!p || !q)
    throw new Error(`Field ${s.field} is unavailable in this frame.`);
  const dim = p.shape[1],
    components = q.shape[1] ?? 1,
    n = p.shape[0];
  if (s.coordinate === "z" && dim < 3)
    throw new Error("The z coordinate requires 3D data.");
  if (s.component === "z" && components > 1 && components < 3)
    throw new Error("This vector has no z component.");
  if (["radial", "tangential"].includes(s.component) && components < dim)
    throw new Error(
      "Radial/tangential projection requires a vector with the spatial dimension.",
    );
  if (
    !s.center.every(Number.isFinite) ||
    (s.sector && ![s.angleMin, s.angleMax].every(Number.isFinite)) ||
    !Number.isInteger(s.bins) ||
    s.bins < 2 ||
    s.bins > 2048 ||
    !Number.isFinite(s.sliceMin) ||
    !Number.isFinite(s.sliceMax) ||
    s.sliceMin > s.sliceMax
  )
    throw new Error(
      "Use finite coordinates, an ordered slice range, and 2–2048 bins.",
    );
  if (s.selection === "material" && !frame.arrays[s.materialField])
    throw new Error("Choose a recorded material field.");
  const mass = frame.arrays.masses,
    density = frame.arrays.densities;
  if (
    s.mode === "binned" &&
    s.weight !== "count" &&
    (!mass || (s.weight === "volume" && !density))
  )
    throw new Error(
      `${s.weight} weighting requires recorded masses${s.weight === "volume" ? " and densities" : ""}.`,
    );
  const points: { x: number; y: number; weight: number; i: number }[] = [];
  let omitted = 0;
  for (let i = 0; i < n; i++) {
    const kind = Number(frame.arrays.kinds?.data[i] ?? 0);
    if (
      (s.selection === "fluid" && kind !== 0) ||
      (s.selection === "kind" && kind !== s.kind)
    )
      continue;
    if (
      s.selection === "material" &&
      Number(frame.arrays[s.materialField].data[i]) !== s.material
    )
      continue;
    const pos = Array.from({ length: dim }, (_, c) =>
      mappedCoordinate(Number(p.data[i * dim + c]), c, domain, s.wrap),
    );
    if (
      s.sliceAxis >= 0 &&
      (pos[s.sliceAxis] < s.sliceMin || pos[s.sliceAxis] > s.sliceMax)
    )
      continue;
    const d = pos.map((v, c) => v - (s.center[c] ?? 0));
    const angle = Math.atan2(d[1], d[0]);
    if (
      s.sector &&
      !(s.angleMin <= s.angleMax
        ? angle >= s.angleMin && angle <= s.angleMax
        : angle >= s.angleMin || angle <= s.angleMax)
    )
      continue;
    const r = Math.hypot(...d),
      rxy = Math.hypot(d[0], d[1]);
    const x =
      s.coordinate === "radius"
        ? r
        : s.coordinate === "angle"
          ? rxy > 0
            ? angle
            : NaN
          : pos[{ x: 0, y: 1, z: 2 }[s.coordinate]];
    const vector = Array.from({ length: components }, (_, c) =>
      Number(q.data[i * components + c]),
    );
    let y = vector[0];
    if (s.component === "radial")
      y = r > 0 ? d.reduce((v, a, c) => v + a * vector[c], 0) / r : NaN;
    else if (s.component === "tangential")
      y = rxy > 0 ? (-d[1] * vector[0] + d[0] * vector[1]) / rxy : NaN;
    else if (components > 1)
      y =
        s.component === "magnitude"
          ? Math.hypot(...vector)
          : vector[{ x: 0, y: 1, z: 2 }[s.component]];
    const weight =
      s.mode === "scatter" || s.weight === "count"
        ? 1
        : Number(mass!.data[i]) /
          (s.weight === "volume" ? Number(density!.data[i]) : 1);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      (s.xlog && x <= 0) ||
      (s.ylog && y <= 0)
    ) {
      omitted++;
      continue;
    }
    points.push({ x, y, weight, i });
  }
  const out: ProfileResult = {
    x: [],
    y: [],
    uid: [],
    indices: [],
    spread: [],
    counts: [],
    accepted: points.length,
    omitted,
    sampled: false,
  };
  if (s.mode === "scatter") {
    const stride = Math.max(1, Math.ceil(points.length / limit));
    out.sampled = stride > 1;
    points.forEach((a, k) => {
      if (k % stride) return;
      out.x.push(a.x);
      out.y.push(a.y);
      out.indices.push(a.i);
      out.uid.push(
        frame.arrays.UIDs ? String(frame.arrays.UIDs.data[a.i]) : null,
      );
    });
  } else if (points.length) {
    let lo = Infinity,
      hi = -Infinity;
    for (const a of points) {
      const x = s.xlog ? Math.log(a.x) : a.x;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    const bins = Array.from({ length: s.bins }, () => ({
      w: 0,
      mean: 0,
      m2: 0,
      count: 0,
    }));
    for (const a of points) {
      const x = s.xlog ? Math.log(a.x) : a.x;
      const b =
        bins[
          Math.min(s.bins - 1, Math.floor(((x - lo) / (hi - lo || 1)) * s.bins))
        ];
      const w = b.w + a.weight,
        delta = a.y - b.mean;
      b.mean += (a.weight / w) * delta;
      b.m2 += a.weight * delta * (a.y - b.mean);
      b.w = w;
      b.count++;
    }
    bins.forEach((b, j) => {
      if (!b.count) return;
      const x = hi === lo ? lo : lo + ((j + 0.5) * (hi - lo)) / s.bins;
      out.x.push(s.xlog ? Math.exp(x) : x);
      out.y.push(b.mean);
      out.spread.push(Math.sqrt(Math.max(0, b.m2 / b.w)));
      out.counts.push(b.count);
    });
  }
  return out;
}
