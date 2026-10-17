import catalogue from "./recorded-demos.json";

export interface RecordedDemo {
  id: string;
  name: string;
  description: string;
  file: string;
  bytes: number;
  sha256: string;
  particles: number;
  frames: number;
  duration: number;
}
export const recordedDemos = catalogue as RecordedDemo[];
export const demoSize = (bytes: number) =>
  `${(bytes / 1048576).toFixed(1)} MiB`;

/** Download explicitly selected product data; never fetch trajectories at startup.
 * Use the deployed base path, including GitHub Pages repository subdirectories.
 */
export async function downloadDemo(
  demo: RecordedDemo,
  signal: AbortSignal,
  progress: (received: number) => void,
  base = import.meta.env?.BASE_URL ?? "./",
  fetcher: typeof fetch = fetch,
): Promise<File> {
  const response = await fetcher(`${base}demos/${demo.file}`, { signal });
  if (!response.ok)
    throw new Error(
      `Demo download failed (${response.status}). Please try again.`,
    );
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > demo.bytes)
          throw new Error("The demo changed. Refresh this page and try again.");
        chunks.push(value);
        progress(received);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    const buffer = await response.arrayBuffer();
    received = buffer.byteLength;
    chunks.push(new Uint8Array(buffer));
    progress(received);
  }
  signal.throwIfAborted();
  if (received !== demo.bytes)
    throw new Error("The demo download was incomplete. Please try again.");
  const file = new File(chunks, demo.file, {
    type: "application/x-hdf5",
    lastModified: 0,
  });
  // Detect stale/mismatched assets before asking HDF5 to interpret the bytes.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  signal.throwIfAborted();
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== demo.sha256)
    throw new Error(
      "The demo did not match this version. Refresh the page and try again.",
    );
  return file;
}
