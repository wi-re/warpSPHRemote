import { NumberControl } from "./NumberControl";
import { useEffect, useState } from "react";
import type { Source } from "./types";
import type { TrajectorySource } from "./sources/client";
import type { TraceSample } from "./sources/traces";
export function useParticleTrace(
  reader: TrajectorySource | undefined,
  source: Source | undefined,
  index: number,
  uid: string,
) {
  const [enabled, setEnabled] = useState(false),
    [past, setPast] = useState(20),
    [future, setFuture] = useState(20);
  const [rows, setRows] = useState<TraceSample[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setRows([]);
    setBusy(false);
    setError("");
    if (!enabled || !uid || !reader || !source) return;
    const abort = new AbortController(),
      start = Math.max(0, index - past),
      end = Math.min(source.frames - 1, index + future);
    setBusy(true);
    (async () => {
      const samples: TraceSample[] = [];
      for (let i = start; i <= end; i += 4) {
        samples.push(
          ...(await reader.trace(
            i,
            Math.min(4, end - i + 1),
            uid,
            abort.signal,
          )),
        );
        if (abort.signal.aborted) return;
        setRows([...samples]);
      }
    })()
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [reader, source?.id, index, uid, enabled, past, future]);
  return {
    enabled,
    setEnabled,
    past,
    setPast,
    future,
    setFuture,
    rows,
    busy,
    error,
  };
}
export function TraceControls({
  trace: t,
  uid,
  supported,
  onClear,
  compact = false,
  hideToggle = false,
}: {
  trace: ReturnType<typeof useParticleTrace>;
  uid: string;
  supported: boolean;
  onClear: () => void;
  compact?: boolean;
  hideToggle?: boolean;
}) {
  return (
    <section className="inspector-section trace-controls">
      {!compact && <div className="section-heading">PARTICLE TRACE</div>}
      {!hideToggle && (
        <label className="trace-enable">
          <input
            type="checkbox"
            aria-label="Show particle trace"
            checked={t.enabled}
            disabled={!supported}
            onChange={(e) => t.setEnabled(e.target.checked)}
          />
          Show trace for picked UID
        </label>
      )}
      {!supported ? (
        <p className="subtle-note">
          Recorded UIDs are required to follow particles across frames.
        </p>
      ) : !compact || t.enabled ? (
        <>
          <div className="probe-coordinates">
            <label>
              Past frames
              <NumberControl
                aria-label="Trace past frames"
                min="0"
                max="1000"
                step="1"
                value={t.past}
                onValueChange={(value) => {
                  const n = value;
                  if (Number.isInteger(n) && n >= 0 && n <= 1000) t.setPast(n);
                }}
              />
            </label>
            <label>
              Future frames
              <NumberControl
                aria-label="Trace future frames"
                min="0"
                max="1000"
                step="1"
                value={t.future}
                onValueChange={(value) => {
                  const n = value;
                  if (Number.isInteger(n) && n >= 0 && n <= 1000)
                    t.setFuture(n);
                }}
              />
            </label>
          </div>
          {uid ? (
            <>
              {!compact && (
                <div className="probe-title">
                  <span>UID {uid}</span>
                  <button
                    className="small-icon"
                    aria-label="Clear particle trace"
                    onClick={onClear}
                  >
                    ×
                  </button>
                </div>
              )}
              <p className="subtle-note">
                {t.busy
                  ? "Reading trace…"
                  : `${t.rows.filter((r) => r.position).length} recorded positions`}{" "}
                · <span style={{ color: "#75ddba" }}>past</span> /{" "}
                <span style={{ color: "#e6b873" }}>future</span>
              </p>
            </>
          ) : (
            <p className="subtle-note">
              Click a particle to trace its UID. The window follows the current
              playback frame.
            </p>
          )}
          <p className="subtle-note">
            Uses original coordinates and recorded frames. Missing UIDs and
            wrapped boundary crossings break the line.
          </p>
          {t.error && (
            <p className="inline-error" role="alert">
              {t.error}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
