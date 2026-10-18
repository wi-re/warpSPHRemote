import type { RawFrame } from "../sources/core";
import { gridLayout, type GridSettings } from "../sources/grid";
import { mappedCoordinate } from "../spatial";
import type { Mapping, Source } from "../types";

export const PARTICLE_STRIDE = 48;
/** One packed, local-coordinate snapshot. UIDs never pass through f32. */
export function prepareParticles(
  raw: RawFrame,
  source: Pick<Source, "domain">,
  field: string,
  mapping: Mapping,
  settings: GridSettings,
) {
  const layout = gridLayout(raw, source, field, mapping, settings);
  const { n, components, domain, lo, hi, width, height, periodic } = layout;
  if (components > 4)
    throw new Error("GPU reconstruction supports up to four field components.");
  const data = new ArrayBuffer(n * PARTICLE_STRIDE),
    f = new Float32Array(data),
    u = new Uint32Array(data);
  const finite32 = (x: number) =>
    Number.isFinite(x) && Number.isFinite(Math.fround(x));
  let maxSupport = 0,
    excluded = 0,
    valid = 0;
  for (let i = 0; i < n; i++) {
    if (Number(raw.kinds.data[i]) !== 0) continue;
    const h = Number(raw.supports.data[i]),
      mass = Number(raw.masses.data[i]),
      rho = Number(raw.densities.data[i]);
    if (![h, mass, rho].every((x) => Number.isFinite(x) && x > 0)) {
      excluded++;
      continue;
    }
    const volume = mass / rho;
    if (
      ![h, h * h, volume, volume / (h * h)].every(
        (x) => finite32(x) && Math.fround(x) > 0,
      )
    )
      throw new Error("Particle scale exceeds portable f32 precision.");
    const off = i * 12;
    for (let c = 0; c < 2; c++) {
      const x =
        mappedCoordinate(Number(raw.positions.data[2 * i + c]), c, domain) -
        lo[c];
      if (!finite32(x))
        throw new Error("Position exceeds portable f32 precision.");
      f[off + c] = x;
    }
    f[off + 2] = h;
    f[off + 3] = volume;
    let flags = 1,
      goodField = true,
      goodVelocity = !!raw.velocities && raw.velocities.shape[1] >= 2;
    for (let c = 0; c < components; c++) {
      const value = Number(raw[field].data[i * components + c]);
      if (!Number.isFinite(value)) goodField = false;
      else if (!finite32(value))
        throw new Error("Field exceeds portable f32 precision.");
      else f[off + 4 + c] = value;
    }
    for (let c = 0; c < 2; c++) {
      const value = raw.velocities
        ? Number(raw.velocities.data[i * raw.velocities.shape[1] + c])
        : NaN;
      if (!Number.isFinite(value)) goodVelocity = false;
      else if (!finite32(value))
        throw new Error("Velocity exceeds portable f32 precision.");
      else f[off + 8 + c] = value;
    }
    if (goodField) flags |= 2;
    if (goodVelocity) flags |= 4;
    u[off + 10] = flags;
    maxSupport = Math.max(maxSupport, Math.fround(h));
    valid++;
  }
  const span = hi.map((x, c) => x - lo[c]);
  if (span.some((x) => !finite32(x) || Math.fround(x) <= 0))
    throw new Error("Domain exceeds portable f32 precision.");
  // Cell width >= largest cutoff, unless the cutoff exceeds the whole domain.
  // No bucket capacity: compact ranges retain every valid fluid particle.
  const bins = span.map((x) =>
    Math.max(1, Math.min(512, Math.floor(x / (maxSupport || x)))),
  );
  const radius = span.map((x, c) =>
    Math.min(bins[c], Math.ceil(maxSupport / (x / bins[c]))),
  );
  // Estimate work to pace query submissions. Dense frames remain valid.
  const occupancy = new Uint32Array(bins[0] * bins[1]);
  for (let i = 0; i < n; i++)
    if (u[i * 12 + 10] & 1) {
      const b = [0, 1].map((c) =>
        Math.max(
          0,
          Math.min(
            bins[c] - 1,
            Math.floor((f[i * 12 + c] / span[c]) * bins[c]),
          ),
        ),
      );
      occupancy[b[1] * bins[0] + b[0]]++;
    }
  let maxOccupancy = 0;
  for (const count of occupancy) maxOccupancy = Math.max(maxOccupancy, count);
  const candidatesPerQuery =
    maxOccupancy *
    Math.min(bins[0], 2 * radius[0] + 1) *
    Math.min(bins[1], 2 * radius[1] + 1);
  const candidates = width * height * candidatesPerQuery;
  const params = new ArrayBuffer(80),
    pf = new Float32Array(params),
    pu = new Uint32Array(params);
  pf.set(span, 0);
  pu.set([width, height], 2);
  pu.set(bins, 4);
  pu.set(radius, 6);
  pu.set(periodic.map(Number), 8);
  pu[10] = n;
  pu[11] = settings.kernel === "wendland2" ? 0 : 1;
  pf[12] = settings.minCoverage;
  pu[13] = components;
  pu[14] = mapping === "magnitude" ? 4 : { x: 0, y: 1, z: 2 }[mapping];
  pu[15] =
    settings.quantity === "divergence"
      ? 1
      : settings.quantity === "vorticity"
        ? 2
        : 0;
  pu[17] = width * height;
  return {
    data,
    params,
    layout,
    bins,
    excluded,
    valid,
    candidates,
    candidatesPerQuery,
  };
}
