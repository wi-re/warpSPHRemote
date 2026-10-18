import { histogram, scalarSamples, spatialSpectrum } from "./analysis";
/// <reference lib="webworker" />
import { MaterialFTLE } from "./ftle";
import { seedMaterial, materialPositions } from "./material";
import { streamlines, type GridData } from "./grid";
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

import { GridBackend } from "../compute/backend";
const gridBackend = new GridBackend();
let source: RawSource | undefined;
let hasSpecificEnergy = false,
  hasVelocity = false;
let physicalTime = false;
let ftleCache: { key: string; context: MaterialFTLE } | undefined;
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
const controllers = new Map<number, AbortController>();
self.onmessage = async (event: MessageEvent) => {
  const { id, operation, args } = event.data;
  if (operation === "cancel") {
    controllers.get(args.id)?.abort();
    return;
  }
  const abort = new AbortController();
  controllers.set(id, abort);
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
      physicalTime = metadata.timeKind === "simulation";
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
        let raw = await read(i, "velocities");
        const pressures = (await read(i, "pressures")).pressures;
        if (pressures) raw = { ...raw, pressures };
        if (hasSpecificEnergy)
          raw = {
            ...raw,
            internalEnergies: (await read(i, "internalEnergies"))
              .internalEnergies,
          };
        const row = reduceDiagnostic(raw, i, source.times[i]);
        if (recorded) {
          for (const key of [
            "kineticEnergy",
            "internalEnergy",
            "totalEnergy",
            "maxSpeed",
            "meanDensity",
            "particles",
          ] as const)
            if (recorded[key] != null) (row as any)[key] = recorded[key];
          if (
            recorded.totalEnergy == null &&
            row.kineticEnergy != null &&
            row.internalEnergy != null
          )
            row.totalEnergy = row.kineticEnergy + row.internalEnergy;
        }
        if (row.internalEnergy == null && source instanceof HDF5Source) {
          const energy = source.recordedInternalEnergy(i);
          if (energy != null) {
            row.internalEnergy = energy;
            row.totalEnergy =
              row.kineticEnergy != null ? row.kineticEnergy + energy : null;
          }
        }
        rows.push(row);
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
    } else if (operation === "materialSeed") {
      source.checkIndex(args.index);
      result = seedMaterial(
        await read(args.index, "UIDs"),
        args.uid,
        args.settings,
        args.index,
        source.times[args.index],
        source.domain,
        args.extra,
      );
    } else if (operation === "material") {
      if (!Array.isArray(args.uids) || args.uids.length > 73 || args.count > 4)
        throw new Error("Material batch exceeds its bounded work limit.");
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
          positions: materialPositions(await read(i, "UIDs"), args.uids),
        });
      }
      result = rows;
    } else if (operation === "ftle") {
      if (!physicalTime)
        throw new Error("FTLE requires recorded physical times.");
      const key = JSON.stringify(args.query),
        q = args.query;
      source.checkIndex(q.start);
      source.checkIndex(q.end);
      if (ftleCache?.key !== key)
        ftleCache = {
          key,
          context: new MaterialFTLE(
            await read(q.start, "UIDs"),
            await read(q.end, "UIDs"),
            q,
            source.times[q.start],
            source.times[q.end],
            source.domain,
          ),
        };
      const batch = ftleCache.context.batch(args.offset, args.count);
      result = batch;
      transfer = [
        batch.values.buffer,
        batch.residual.buffer,
        batch.condition.buffer,
        batch.counts.buffer,
      ];
    } else if (operation === "analysis") {
      source.checkIndex(args.index);
      let grid: GridData | undefined;
      if (args.grid) {
        const q = args.grid,
          key = JSON.stringify([q.index, q.field, q.mapping, q.settings]);
        grid = gridCache?.key === key ? gridCache.grid : undefined;
        if (!grid) {
          let raw = await read(q.index, q.field);
          if (!raw.velocities && hasVelocity)
            raw = {
              ...raw,
              velocities: (await read(q.index, "velocities")).velocities,
            };
          grid = await gridBackend.reconstruct(
            raw,
            source,
            q.field,
            q.mapping,
            q.settings,
            q.index,
            source.times[q.index],
            abort.signal,
          );
          gridCache = { key, grid };
        }
      }
      const value =
        args.kind === "histogram"
          ? histogram(
              grid?.values ??
                scalarSamples(
                  await read(args.index, args.field),
                  args.field,
                  args.mapping,
                ),
              args.bins,
            )
          : spatialSpectrum(grid!, args);
      result = {
        ...value,
        index: args.index,
        time: source.times[args.index],
        field:
          args.grid?.settings.quantity &&
          args.grid.settings.quantity !== "field"
            ? args.grid.settings.quantity
            : args.field,
      };
      if (value.kind === "fft2" && value.image) transfer = [value.image.buffer];
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
        grid = await gridBackend.reconstruct(
          raw,
          source,
          args.field,
          args.mapping,
          args.settings,
          args.index,
          source.times[args.index],
          abort.signal,
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
      const lic = args.lic
        ? await gridBackend.lic(grid, args.lic, args.settings.backend)
        : undefined;
      result = {
        lic,
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
        ...(lic ? [lic.values.buffer] : []),
      ];
    } else throw new Error("Unknown source operation.");
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(id);
  }
};
