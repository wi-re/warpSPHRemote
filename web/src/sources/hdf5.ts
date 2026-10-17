import { domainFrom } from "../spatial";
import type * as H5 from "h5wasm";
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

export class HDF5Source extends RawSource {
  private layout: "columns" | "states" | "checkpoint" | "stacked";
  private keys: string[] = [];
  private stackedRoot = "frames";
  private keyCache = new Map<string, Set<string>>();
  constructor(
    id: string,
    name: string,
    private file: H5.File,
    private api: typeof H5,
  ) {
    super(id);
    this.name = name;
    this.format = "Local HDF5";
    this.storedInternalEnergy = ["internalEnergy", "thermalEnergy"].some(
      (name) => this.entry(`diagnostics/${name}`) instanceof api.Dataset,
    );
    const positions = this.entry("positions"),
      stacked = this.entry("frames/positions");
    if (stacked instanceof api.Dataset && stacked.shape?.length === 3) {
      this.layout = "stacked";
    } else if (
      positions instanceof api.Dataset &&
      positions.shape?.length === 3
    ) {
      this.layout = "stacked";
      this.stackedRoot = "";
    } else if (positions instanceof api.Group && positions.keys().length) {
      this.layout = "columns";
      this.keys = positions.keys().sort(naturalCompare);
    } else if (
      this.entry("states") instanceof api.Group &&
      (this.entry("states") as H5.Group).keys().length
    ) {
      this.layout = "states";
      this.keys = (this.entry("states") as H5.Group)
        .keys()
        .sort(naturalCompare);
    } else if (this.entry("state/positions") instanceof api.Dataset) {
      this.layout = "checkpoint";
      this.keys = ["state"];
    } else
      throw new Error(
        "Unsupported HDF5 layout. Expected positions/frame_*, states/*, state/positions, or frames/positions[T,N,D].",
      );
    const domainVector = (path: string): number[] | null => {
      const entity = this.entry(path);
      if (entity instanceof api.Dataset)
        return Array.from(this.numeric(entity).data, Number);
      if (entity instanceof api.Group) {
        const keys = Object.keys(entity.attrs)
          .filter((k) => /^item_\d+$/.test(k))
          .sort(naturalCompare);
        if (keys.length) return keys.map((k) => Number(entity.attrs[k].value));
      }
      return null;
    };
    for (const path of ["domain", "config/domain", "config/config/domain"]) {
      const min = domainVector(`${path}/min`),
        max = domainVector(`${path}/max`),
        periodic = domainVector(`${path}/periodic`);
      if (min && max && periodic) {
        this.domain = domainFrom(min, max, periodic);
        break;
      }
    }
    if (this.layout === "stacked") {
      const ds = this.entry(this.dynamicPath("positions")) as H5.Dataset,
        n = ds.shape![0],
        time = this.entry("time") ?? this.entry("times");
      if (time instanceof api.Dataset && time.shape?.[0] === n) {
        const a = this.numeric(time);
        this.times = Array.from(a.data, Number);
      } else {
        this.timeKind = "frame";
        this.times = Array.from({ length: n }, (_, i) => i);
      }
    } else {
      let missing = false;
      this.times = this.keys.map((key, i) => {
        const ds = this.entry(`times/${key}`);
        if (ds instanceof api.Dataset) return Number(this.numeric(ds).data[0]);
        const group =
            this.layout === "columns" ? this.file : this.stateGroup(key),
          parent =
            this.layout === "states" ? this.entry(`states/${key}`) : null;
        const value =
          group.attrs.time?.value ??
          group.attrs.t?.value ??
          (parent instanceof api.Group
            ? (parent.attrs.time?.value ?? parent.attrs.t?.value)
            : null) ??
          (this.layout === "checkpoint" ? this.file.attrs.time?.value : null);
        if (value === undefined || value === null) {
          missing = true;
          return i;
        }
        return Number(
          ArrayBuffer.isView(value)
            ? (value as RawNumeric)[0]
            : Array.isArray(value)
              ? value[0]
              : value,
        );
      });
      if (missing) {
        this.timeKind = "frame";
        this.times = this.keys.map((_, i) => i);
      }
    }
  }
  private names(group: H5.Group) {
    let set = this.keyCache.get(group.path);
    if (!set) {
      set = new Set(group.keys());
      this.keyCache.set(group.path, set);
    }
    return set;
  }
  private entry(path: string): H5.Entity | null {
    let current: H5.Entity = this.file;
    for (const part of path.split("/").filter(Boolean)) {
      if (
        !(current instanceof this.api.Group) ||
        !this.names(current).has(part)
      )
        return null;
      const next = current.get(part);
      if (!next) return null;
      current = next;
    }
    return current;
  }
  private numeric(ds: H5.Dataset, index?: number): RawArray {
    const shape = ds.shape;
    if (!shape) throw new Error(`Unsupported dataset shape at ${ds.path}.`);
    const value =
      index === undefined
        ? ds.value
        : ds.slice([[index, index + 1], ...shape.slice(1).map(() => [] as [])]);
    if (!ArrayBuffer.isView(value) || value instanceof DataView)
      throw new Error(
        `Dataset ${ds.path} is not a supported numeric array. Object/callable metadata is not executed.`,
      );
    return {
      data: value as RawNumeric,
      shape: index === undefined ? shape : shape.slice(1),
    };
  }
  private stateGroup(key: string): H5.Group {
    const prefix = this.layout === "checkpoint" ? "state" : `states/${key}`;
    return (this.entry(`${prefix}/state`) ?? this.entry(prefix)) as H5.Group;
  }
  private dynamicPath(name: string) {
    return this.stackedRoot ? `${this.stackedRoot}/${name}` : name;
  }
  read(index: number, field?: string): RawFrame {
    this.checkIndex(index);
    const frame: RawFrame = {},
      wanted = (name: string) =>
        !field || baseFields.includes(name) || name === field;
    if (this.layout === "stacked") {
      const dynamic = this.stackedRoot
        ? (this.entry(this.stackedRoot) as H5.Group)
        : this.file;
      for (const name of this.names(dynamic)) {
        const normalized = canonical(name),
          ds = dynamic.get(name);
        if (
          wanted(normalized) &&
          ds instanceof this.api.Dataset &&
          ds.shape &&
          ds.shape.length >= 2 &&
          ds.shape.length <= 3 &&
          ds.shape[0] === this.times.length
        )
          frame[normalized] = this.numeric(ds, index);
      }
      const n = frame.positions?.shape[0];
      for (const root of ["particles", "static"]) {
        const group = this.entry(root);
        if (!(group instanceof this.api.Group)) continue;
        for (const name of this.names(group)) {
          const normalized = canonical(name),
            ds = group.get(name);
          if (
            !frame[normalized] &&
            wanted(normalized) &&
            ds instanceof this.api.Dataset &&
            ds.shape?.[0] === n &&
            ds.shape.length <= 2
          )
            frame[normalized] = this.numeric(ds);
        }
      }
    } else if (this.layout === "columns") {
      const key = this.keys[index],
        positions = this.entry(`positions/${key}`) as H5.Dataset,
        n = positions.shape![0];
      for (const name of this.names(this.file)) {
        const normalized = canonical(name);
        if (!wanted(normalized)) continue;
        const ds = this.entry(`${name}/${key}`);
        if (
          ds instanceof this.api.Dataset &&
          ds.shape?.[0] === n &&
          ds.shape.length <= 2
        )
          frame[normalized] = this.numeric(ds);
      }
    } else {
      const group = this.stateGroup(this.keys[index]);
      for (const name of this.names(group)) {
        const normalized = canonical(name),
          ds = group.get(name);
        if (
          wanted(normalized) &&
          ds instanceof this.api.Dataset &&
          ds.shape?.length &&
          ds.shape.length <= 2
        )
          frame[normalized] = this.numeric(ds);
      }
    }
    const n = frame.positions?.shape[0];
    for (const name of ["kinds", "UIDs", "masses", "supports", "materials"]) {
      if (frame[name] || !wanted(name)) continue;
      const ds = this.entry(`combined${name[0].toUpperCase() + name.slice(1)}`);
      if (ds instanceof this.api.Dataset) {
        if (ds.shape?.[0] !== n)
          throw new Error(
            "Particle count changed but only initial combined metadata was recorded.",
          );
        frame[name] = this.numeric(ds);
      }
    }
    return validateRaw(frame);
  }
  recordedDiagnostic(index: number) {
    const row: Record<string, number | null> = {};
    for (const name of [
      "kineticEnergy",
      "maxSpeed",
      "meanDensity",
      "particles",
    ]) {
      const ds = this.entry(`diagnostics/${name}`);
      if (
        !(ds instanceof this.api.Dataset) ||
        ds.shape?.length !== 1 ||
        ds.shape[0] !== this.times.length
      )
        return null;
      const value = Number(this.numeric(ds, index).data[0]);
      row[name] = Number.isFinite(value) ? value : null;
    }
    row.internalEnergy = this.recordedInternalEnergy(index);
    return row.particles === null
      ? null
      : {
          index,
          time: this.times[index],
          particles: row.particles,
          kineticEnergy: row.kineticEnergy,
          internalEnergy: row.internalEnergy ?? null,
          totalEnergy:
            row.internalEnergy != null &&
            row.kineticEnergy != null &&
            Number.isFinite(row.internalEnergy + row.kineticEnergy)
              ? row.internalEnergy + row.kineticEnergy
              : null,
          maxSpeed: row.maxSpeed,
          meanDensity: row.meanDensity,
        };
  }
  recordedInternalEnergy(index: number): number | null {
    for (const name of ["internalEnergy", "thermalEnergy"]) {
      const ds = this.entry(`diagnostics/${name}`);
      if (
        ds instanceof this.api.Dataset &&
        ds.shape?.length === 1 &&
        ds.shape[0] === this.times.length
      ) {
        const value = Number(this.numeric(ds, index).data[0]);
        return Number.isFinite(value) ? value : null;
      }
    }
    return null;
  }
  close() {
    this.file.close();
  }
}
