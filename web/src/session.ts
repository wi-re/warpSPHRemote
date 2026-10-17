import {
  initialOptions,
  type ViewOptions,
  type DiagnosticMetric,
} from "./types";
import { palettes } from "./palettes";
import { initialGrid } from "./sources/grid";
import type { FieldPreferences } from "./FieldView";
import type { RecordedDemo } from "./recordedDemos";
/** One browser-local snapshot, replacing the previous recording atomically. */
export interface RememberedRecording {
  files: { blob: Blob; name: string; type: string; lastModified: number }[];
  key: string;
}
const database = "warpsph-remote-session-v1",
  store = "session";
let dbPromise: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      dbPromise = undefined;
      reject(new Error("Browser storage is blocked by another viewer tab."));
    };
  }));
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode),
      request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(
        tx.error ??
          request.error ??
          new Error("Could not save the local recording."),
      );
  });
}
export const fileKey = (files: File[]) =>
  JSON.stringify(files.map((f) => [f.name, f.size, f.lastModified]));
export async function rememberFiles(files: File[]) {
  const record: RememberedRecording = {
    key: fileKey(files),
    files: files.map((f) => ({
      blob: f,
      name: f.name,
      type: f.type,
      lastModified: f.lastModified,
    })),
  };
  await transaction("readwrite", (store) => store.put(record, "last"));
  return record.key;
}
export async function recallFiles(): Promise<{
  key: string;
  files: File[];
} | null> {
  const record = await transaction<RememberedRecording | undefined>(
    "readonly",
    (store) => store.get("last"),
  );
  if (!record?.files?.length) return null;
  return {
    key: record.key,
    files: record.files.map(
      (f) =>
        new File([f.blob], f.name, {
          type: f.type,
          lastModified: f.lastModified,
        }),
    ),
  };
}
export async function forgetFiles() {
  await transaction("readwrite", (store) => store.delete("last"));
  try {
    localStorage.removeItem("warpsph-last-view");
  } catch {}
}
type DemoIdentity = Pick<RecordedDemo, "id" | "file" | "bytes" | "sha256">;
interface CachedDemo {
  sha256: string;
  file: string;
  blob: Blob;
}
/** Separate immutable demo slots: selecting another recording never replaces them. */
export async function cacheDemo(demo: DemoIdentity, file: File) {
  if (file.name !== demo.file || file.size !== demo.bytes)
    throw new Error("The recording does not match the demo catalogue.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== demo.sha256)
    throw new Error("The recording does not match this demo version.");
  await transaction("readwrite", (store) =>
    store.put(
      { sha256: demo.sha256, file: demo.file, blob: file } satisfies CachedDemo,
      `demo:${demo.id}`,
    ),
  );
}
export async function recallDemo(demo: DemoIdentity): Promise<File | null> {
  const saved = await transaction<CachedDemo | undefined>("readonly", (store) =>
    store.get(`demo:${demo.id}`),
  );
  if (
    !saved ||
    saved.sha256 !== demo.sha256 ||
    saved.file !== demo.file ||
    saved.blob?.size !== demo.bytes
  )
    return null;
  return new File([saved.blob], demo.file, {
    type: "application/x-hdf5",
    lastModified: 0,
  });
}
export async function forgetDemo(id: string) {
  await transaction("readwrite", (store) => store.delete(`demo:${id}`));
}
export function rememberEnabled() {
  try {
    return localStorage.getItem("warpsph-remember") !== "false";
  } catch {
    return true;
  }
}
export function setRememberEnabled(value: boolean) {
  try {
    localStorage.setItem("warpsph-remember", String(value));
  } catch {}
}
export interface SavedView {
  key: string;
  index: number;
  field: string;
  options?: ViewOptions;
  fieldView?: FieldPreferences;
  playback?: { speed: number; loop: boolean };
  metric?: DiagnosticMetric | "pressure";
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const finite = (
  v: unknown,
  fallback: number,
  min = -Infinity,
  max = Infinity,
) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : fallback;
/** Treat browser storage as versioned, optional input; tolerate old and corrupt values. */
export function sanitizeView(value: unknown, key: string): SavedView | null {
  if (!object(value) || value.key !== key) return null;
  const view: SavedView = {
    key,
    index: Number.isInteger(value.index) && value.index >= 0 ? value.index : 0,
    field: typeof value.field === "string" ? value.field : "velocities",
  };
  if (object(value.options)) {
    const o = value.options,
      options = { ...initialOptions };
    for (const name of [
      "wrapPeriodic",
      "physical",
      "boundaries",
      "ghosts",
      "grid",
    ] as const)
      if (typeof o[name] === "boolean") options[name] = o[name];
    options.palette =
      typeof o.palette === "string" && Object.hasOwn(palettes, o.palette)
        ? o.palette
        : initialOptions.palette;
    options.mapping = oneOf(
      o.mapping,
      ["magnitude", "x", "y", "z"] as const,
      "magnitude",
    );
    options.normalization = oneOf(
      o.normalization,
      ["linear", "log", "symlog"] as const,
      "linear",
    );
    options.range = oneOf(o.range, ["frame", "fixed"] as const, "frame");
    options.min = finite(o.min, 0);
    options.max = finite(o.max, 1);
    if (
      !(options.max > options.min) ||
      (options.normalization === "log" && options.min <= 0)
    )
      options.range = "frame";
    options.size = finite(o.size, 1, 0.25, 2.5);
    options.background = oneOf(
      o.background,
      ["dark", "light"] as const,
      "dark",
    );
    options.clipAxis = oneOf(o.clipAxis, [-1, 0, 1, 2], -1);
    options.clip = finite(o.clip, 1, 0, 1);
    view.options = options;
  }
  if (object(value.fieldView)) {
    const f = value.fieldView,
      g = object(f.settings) ? f.settings : {};
    view.fieldView = {
      mode: oneOf(f.mode, ["particles", "grid", "both"] as const, "particles"),
      flow: f.flow === true,
      settings: {
        resolution: oneOf(
          g.resolution,
          [128, 256, 512] as const,
          initialGrid.resolution,
        ),
        kernel: oneOf(
          g.kernel,
          ["wendland2", "wendland4"] as const,
          initialGrid.kernel,
        ),
        minCoverage: finite(g.minCoverage, initialGrid.minCoverage, 0.05, 0.95),
        wrapPeriodic: view.options?.wrapPeriodic ?? initialOptions.wrapPeriodic,
      },
      seeds: Number.isInteger(f.seeds) ? finite(f.seeds, 8, 2, 16) : 8,
      seedMode: oneOf(f.seedMode, ["regular", "picked"] as const, "regular"),
    };
    if (
      Array.isArray(f.seed) &&
      f.seed.length === 2 &&
      f.seed.every((v: unknown) => typeof v === "number" && Number.isFinite(v))
    )
      view.fieldView.seed = [...f.seed];
    else if (view.fieldView.seedMode === "picked")
      view.fieldView.seedMode = "regular";
  }
  if (object(value.playback))
    view.playback = {
      speed: oneOf(value.playback.speed, [0.25, 0.5, 1, 2, 4], 1),
      loop: value.playback.loop !== false,
    };
  view.metric = oneOf(
    value.metric,
    [
      "kineticEnergy",
      "internalEnergy",
      "totalEnergy",
      "maxSpeed",
      "meanDensity",
      "pressure",
    ] as const,
    "kineticEnergy",
  );
  return view;
}
export function recallView(key: string): SavedView | null {
  try {
    const view = JSON.parse(
      localStorage.getItem("warpsph-last-view") ?? "null",
    );
    return sanitizeView(view, key);
  } catch {
    return null;
  }
}
export function saveView(view: SavedView) {
  try {
    localStorage.setItem("warpsph-last-view", JSON.stringify(view));
  } catch {}
}
