/// <reference lib="webworker" />
import { reconstructGrid, streamlines, type GridData } from "./grid";
import { tracePosition } from "./traces";
import {
  DemoSource,
  displayFrame,
  reduceDiagnostic,
  type RawFrame,
  type RawSource,
} from "./core";
import { samplePressures } from "./probes";
import { NPZSource } from "./npz";
import { HDF5Source } from "./hdf5";

let source: RawSource | undefined;
let hasSpecificEnergy = false,
  hasVelocity = false;
let gridCache: { key: string; grid: GridData } | undefined;
const frames = new Map<string, RawFrame>();
let cacheBytes = 0;
async function read(index: number, field: string) {
  const key = `${index}:${field}`,
    cached = frames.get(key);
  if (cached) return cached;
  const f = await source!.read(index, field);
  const size = Object.values(f).reduce((sum, a) => sum + a.data.byteLength, 0);
  if (size <= 64 * 1024 * 1024) {
    while (frames.size >= 2 || cacheBytes + size > 64 * 1024 * 1024) {
      const first = frames.keys().next().value!;
      const old = frames.get(first)!;
      cacheBytes -= Object.values(old).reduce(
        (sum, a) => sum + a.data.byteLength,
        0,
      );
      frames.delete(first);
    }
    frames.set(key, f);
    cacheBytes += size;
  }
  return f;
}
self.onmessage = async (event: MessageEvent) => {
  const { id, operation, args } = event.data;
  try {
    let result: unknown,
      transfer: Transferable[] = [];
    if (operation === "open") {
      if (args.demo) {
        source = new DemoSource(args.demo);
      } else {
        const files = args.files as File[],
          hdf = files.filter((f) => /\.(h5|hdf5)$/i.test(f.name));
        if (hdf.length) {
          if (hdf.length !== 1 || files.length !== 1)
            throw new Error("Select one HDF5 recording at a time.");
          const api = await import("h5wasm"),
            module = await api.ready,
            FS = module.FS;
          FS.mkdir("/recording");
          FS.mount(FS.filesystems.WORKERFS, { files: hdf }, "/recording");
          source = new HDF5Source(
            args.sourceId,
            hdf[0].name,
            new api.File(`/recording/${hdf[0].name}`, "r"),
            api,
          );
        } else {
          const npz = new NPZSource(args.sourceId, files);
          await npz.initialize(files);
          source = npz;
        }
      }
      const metadata = await source.metadata();
      hasVelocity = metadata.fields.some((f) => f.name === "velocities");
      hasSpecificEnergy = metadata.fields.some(
        (f) => f.name === "internalEnergies",
      );
      result = metadata;
    } else if (!source) throw new Error("No recording is open.");
    else if (operation === "frame") {
      const frame = displayFrame(
        await read(args.index, args.field),
        args.index,
        source.times[args.index],
        args.field,
      );
      result = frame;
      transfer = Object.values(frame.arrays).map(
        (a) => a.data.buffer as ArrayBuffer,
      );
    } else if (operation === "diagnostics") {
      const rows = [];
      for (
        let i = args.start;
        i < Math.min(args.start + args.count, source.times.length);
        i++
      ) {
        const recorded =
          source instanceof HDF5Source ? source.recordedDiagnostic(i) : null;
        if (recorded && (!hasSpecificEnergy || recorded.internalEnergy != null))
          rows.push(recorded);
        else {
          let raw = await read(i, "velocities");
          if (hasSpecificEnergy)
            raw = {
              ...raw,
              internalEnergies: (await read(i, "internalEnergies"))
                .internalEnergies,
            };
          const row = reduceDiagnostic(raw, i, source.times[i]);
          const energy =
            source instanceof HDF5Source
              ? source.recordedInternalEnergy(i)
              : null;
          if (row.internalEnergy == null && energy != null) {
            row.internalEnergy = energy;
            row.totalEnergy =
              row.kineticEnergy != null ? row.kineticEnergy + energy : null;
          }
          rows.push(row);
        }
      }
      result = rows;
    } else if (operation === "probes") {
      const rows = [];
      for (
        let i = args.start;
        i < Math.min(args.start + args.count, source.times.length);
        i++
      ) {
        source.checkIndex(i);
        rows.push({
          index: i,
          time: source.times[i],
          values: samplePressures(
            await read(i, "pressures"),
            args.probes,
            source.domain,
          ),
        });
      }
      result = rows;
    } else if (operation === "trace") {
      const rows = [];
      for (
        let i = args.start;
        i < Math.min(args.start + args.count, source.times.length);
        i++
      ) {
        source.checkIndex(i);
        rows.push({
          index: i,
          time: source.times[i],
          position: tracePosition(await read(i, "UIDs"), args.uid),
        });
      }
      result = rows;
    } else if (operation === "grid") {
      const key = JSON.stringify([
        args.index,
        args.field,
        args.mapping,
        args.settings,
      ]);
      let grid = gridCache?.key === key ? gridCache.grid : undefined;
      if (!grid) {
        let raw = await read(args.index, args.field);
        if (!raw.velocities && hasVelocity)
          raw = {
            ...raw,
            velocities: (await read(args.index, "velocities")).velocities,
          };
        grid = reconstructGrid(
          raw,
          source,
          args.field,
          args.mapping,
          args.settings,
          args.index,
          source.times[args.index],
        );
        gridCache = { key, grid };
      }
      const lines = args.streams
        ? streamlines(grid, args.streams, args.seed ? [args.seed] : undefined)
        : new Float32Array();
      const copy = {
        ...grid,
        values: grid.values.slice(),
        velocity: grid.velocity.slice(),
        coverage: grid.coverage.slice(),
        velocityValid: grid.velocityValid.slice(),
      };
      result = {
        grid: copy,
        lines,
        field: args.field,
        mapping: args.mapping,
        sourceId: source.id,
      };
      transfer = [
        copy.values.buffer,
        copy.velocity.buffer,
        copy.coverage.buffer,
        copy.velocityValid.buffer,
        lines.buffer,
      ];
    } else throw new Error("Unknown source operation.");
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
