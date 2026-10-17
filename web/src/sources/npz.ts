import { domainFrom } from "../spatial";
import { unzipSync } from "fflate";
import {
  RawSource,
  baseFields,
  canonical,
  naturalCompare,
  validateRaw,
  type RawArray,
  type RawFrame,
  type RawNumeric,
} from "./core";
export function decodeNPY(bytes: Uint8Array): RawArray {
  if (
    bytes.length < 10 ||
    bytes[0] !== 147 ||
    new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY"
  )
    throw new Error("Invalid NumPy array.");
  const major = bytes[6],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    prefix = major === 1 ? 10 : 12;
  if (![1, 2, 3].includes(major) || bytes.length < prefix)
    throw new Error("Unsupported NumPy version.");
  const headerLength =
      major === 1 ? view.getUint16(8, true) : view.getUint32(8, true),
    start = prefix + headerLength;
  if (start > bytes.length) throw new Error("Truncated NumPy header.");
  const text = new TextDecoder().decode(bytes.subarray(prefix, start)),
    dtype = text.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/)?.[1],
    shapeText = text.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)?.[1];
  if (!dtype || shapeText === undefined)
    throw new Error("Unsupported NumPy header.");
  if (/['"]fortran_order['"]\s*:\s*True/.test(text))
    throw new Error(
      "Fortran-ordered arrays are not supported. Save C-contiguous arrays.",
    );
  const shape = shapeText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
    width = Number(dtype.slice(2)),
    count = shape.reduce((a, b) => a * b, 1);
  if (
    shape.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(count) ||
    !Number.isInteger(width) ||
    width < 1 ||
    start + count * width !== bytes.length
  )
    throw new Error("Invalid or truncated NumPy shape.");
  const raw = bytes.slice(start);
  if (dtype[0] === ">")
    for (let i = 0; i < raw.length; i += width)
      for (let j = 0; j < width / 2; j++) {
        const t = raw[i + j];
        raw[i + j] = raw[i + width - j - 1];
        raw[i + width - j - 1] = t;
      }
  const constructors: Record<string, (buffer: ArrayBuffer) => RawNumeric> = {
    f4: (b) => new Float32Array(b),
    f8: (b) => new Float64Array(b),
    i1: (b) => new Int8Array(b),
    u1: (b) => new Uint8Array(b),
    b1: (b) => new Uint8Array(b),
    i2: (b) => new Int16Array(b),
    u2: (b) => new Uint16Array(b),
    i4: (b) => new Int32Array(b),
    u4: (b) => new Uint32Array(b),
    i8: (b) => new BigInt64Array(b),
    u8: (b) => new BigUint64Array(b),
  };
  const make = constructors[dtype.slice(1)];
  if (!make)
    throw new Error(
      `Unsupported NumPy dtype ${dtype}; object arrays are never executed.`,
    );
  return { data: make(raw.buffer), shape };
}
export async function readNPZ(
  file: File,
  wanted?: Set<string>,
): Promise<Record<string, RawArray>> {
  const zipped = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(zipped, {
    filter: (entry) =>
      entry.name.endsWith(".npy") &&
      (!wanted || wanted.has(canonical(entry.name.slice(0, -4)))),
  });
  return Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [
      canonical(name.slice(0, -4)),
      decodeNPY(bytes),
    ]),
  );
}
export class NPZSource extends RawSource {
  files: File[];
  constructor(id: string, files: File[]) {
    super(id);
    this.files = files
      .filter((f) => /\.npz$/i.test(f.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    this.name =
      this.files.length === 1
        ? this.files[0].name
        : `${this.files[0]?.name.replace(/\d+(?=\.npz$)/, "…")} · ${this.files.length} snapshots`;
    this.format = "Local NPZ snapshots";
    if (!this.files.length)
      throw new Error("Select at least one NPZ snapshot.");
    if (new Set(this.files.map((f) => f.name)).size !== this.files.length)
      throw new Error(
        "Snapshot file names must be unique. Choose one recording at a time.",
      );
  }
  async initialize(selected: File[]) {
    const geometry = await readNPZ(
      this.files[0],
      new Set(["domain_min", "domain_max", "periodic"]),
    );
    if (geometry.domain_min && geometry.domain_max && geometry.periodic)
      this.domain = domainFrom(
        Array.from(geometry.domain_min.data, Number),
        Array.from(geometry.domain_max.data, Number),
        Array.from(geometry.periodic.data, Number),
      );

    const measurement = selected.find((f) => f.name === "measurements.json"),
      byStep = new Map<number, number>();
    if (measurement) {
      const rows = JSON.parse(await measurement.text()).frames ?? [];
      for (const row of rows)
        if (Number.isFinite(row.step) && Number.isFinite(row.time))
          byStep.set(row.step, row.time);
    }
    const times: (number | undefined)[] = [];
    for (const file of this.files) {
      const fields = await readNPZ(file, new Set(["time", "t"]));
      const recorded = fields.time ?? fields.t;
      const step = file.name.match(/(\d+)\.npz$/)?.[1];
      times.push(
        recorded?.data.length === 1
          ? Number(recorded.data[0])
          : step
            ? byStep.get(+step)
            : undefined,
      );
    }
    if (times.some((t) => t === undefined)) {
      this.timeKind = "frame";
      this.times = this.files.map((_, i) => i);
    } else this.times = times as number[];
  }
  async read(index: number, field?: string): Promise<RawFrame> {
    this.checkIndex(index);
    const all = await readNPZ(
        this.files[index],
        field ? new Set([...baseFields, field]) : undefined,
      ),
      p = all.positions;
    if (!p) throw new Error("Snapshot has no positions array.");
    return validateRaw(
      Object.fromEntries(
        Object.entries(all).filter(
          ([name, a]) =>
            !["time", "t", "domain_min", "domain_max", "periodic"].includes(
              name,
            ) &&
            a.shape.length > 0 &&
            a.shape.length <= 2 &&
            a.shape[0] === p.shape[0],
        ),
      ),
    );
  }
}
