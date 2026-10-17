import { useEffect, useRef, useState } from "react";
/** Explicit developer route; tests run on the same worker WebGPU path as files. */
export default function ComputeCheck() {
  const [rows, setRows] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  function run() {
    worker.current?.terminate();
    setRows([]);
    setBusy(true);
    const w = new Worker(
      new URL("./compute/check.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = w;
    w.onmessage = ({ data }) => {
      if (data.row) setRows((old) => [...old, data.row]);
      if (data.error) {
        setRows((old) => [...old, `FAILED: ${data.error}`]);
        setBusy(false);
      }
      if (data.done) setBusy(false);
    };
    w.onerror = (e) => {
      setRows((old) => [...old, `FAILED: ${e.message}`]);
      setBusy(false);
    };
    w.postMessage({ run: true });
  }
  return (
    <main style={{ padding: 32, overflow: "auto", height: "100vh" }}>
      <h1>WebGPU numerical checks</h1>
      <p>
        Runs real WGSL kernels in a worker and compares all grid samples against
        the independent f64 CPU scatter reference.
      </p>
      <button onClick={run} disabled={busy}>
        {busy ? "Checking…" : "Run GPU checks"}
      </button>{" "}
      <a href={location.pathname}>Return to viewer</a>
      <pre style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }} role="status">
        {rows.join("\n")}
      </pre>
    </main>
  );
}
