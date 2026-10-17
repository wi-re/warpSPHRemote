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
}
export function recallView(key: string): SavedView | null {
  try {
    const view = JSON.parse(
      localStorage.getItem("warpsph-last-view") ?? "null",
    );
    return view?.key === key ? view : null;
  } catch {
    return null;
  }
}
export function saveView(view: SavedView) {
  try {
    localStorage.setItem("warpsph-last-view", JSON.stringify(view));
  } catch {}
}
