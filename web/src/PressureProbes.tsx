import { NumberControl } from "./NumberControl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Source } from "./types";
import type { TrajectorySource } from "./sources/client";
import type { PressureProbe, ProbeSample } from "./sources/probes";
import { formatNumber } from "./data";

export function usePressureProbes(
  reader: TrajectorySource | undefined,
  source: Source | undefined,
  index: number,
) {
  const [probes, setProbes] = useState<PressureProbe[]>([]);
  const [active, setActive] = useState("");
  const [samples, setSamples] = useState<ProbeSample[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scan = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const supported = !!source?.fields.some(
    (f) => f.name === "pressures" && f.components === 1,
  );
  const merge = useCallback(
    (rows: ProbeSample[]) =>
      setSamples((old) =>
        [...new Map([...old, ...rows].map((r) => [r.index, r])).values()].sort(
          (a, b) => a.index - b.index,
        ),
      ),
    [],
  );
  useEffect(() => {
    setProbes([]);
    setActive("");
  }, [source?.id]);
  useEffect(() => {
    generation.current++;
    scan.current?.abort();
    setBusy(false);
    setSamples([]);
    setError("");
    return () => {
      generation.current++;
      scan.current?.abort();
    };
  }, [source?.id, probes]);
  useEffect(() => {
    if (!supported || !reader || !probes.length) return;
    const abort = new AbortController();
    reader
      .probes(index, 1, probes, abort.signal)
      .then(merge)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [reader, supported, index, probes, merge]);
  const generate = async () => {
    if (!reader || !source || !probes.length) return;
    scan.current?.abort();
    const controller = new AbortController();
    scan.current = controller;
    const version = generation.current;
    setBusy(true);
    setError("");
    try {
      for (let start = 0; start < source.frames; start += 4) {
        const rows = await reader.probes(
          start,
          Math.min(4, source.frames - start),
          probes,
          controller.signal,
        );
        if (controller.signal.aborted || version !== generation.current) return;
        merge(rows);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  const add = () => {
    if (!source || probes.length >= 4) return;
    const id = crypto.randomUUID();
    const span = Math.max(
      ...source.bounds[0].map((v, c) => source.bounds[1][c] - v),
      1e-6,
    );
    const probe: PressureProbe = {
      id,
      name: `Probe ${probes.length + 1}`,
      position: source.bounds[0].map((v, c) => (v + source.bounds[1][c]) / 2),
      radius: span / 25,
      method: "idw",
    };
    setProbes((old) => [...old, probe]);
    setActive(id);
  };
  const update = (patch: Partial<PressureProbe>) =>
    setProbes((old) =>
      old.map((p) => (p.id === active ? { ...p, ...patch } : p)),
    );
  return {
    probes,
    active,
    setActive,
    samples,
    busy,
    error,
    supported,
    generate,
    add,
    update,
    cancel: () => {
      scan.current?.abort();
      setBusy(false);
    },
    remove: () => {
      setProbes((old) => old.filter((p) => p.id !== active));
      setActive(probes.find((p) => p.id !== active)?.id ?? "");
    },
    current: samples.find((s) => s.index === index),
  };
}
export type ProbeController = ReturnType<typeof usePressureProbes>;
export function PressureControls({
  controller: c,
  selectedPosition,
}: {
  controller: ProbeController;
  selectedPosition: number[];
}) {
  const p = c.probes.find((p) => p.id === c.active);
  return (
    <section className="inspector-section pressure-controls">
      <div className="section-heading">
        PRESSURE PROBES{" "}
        <button
          className="text-button add-probe"
          onClick={c.add}
          disabled={!c.supported || c.probes.length >= 4}
          aria-label="Add pressure probe"
        >
          + Add probe
        </button>
      </div>
      {!c.supported ? (
        <p className="subtle-note">
          No scalar pressure array was recorded. Pressure is not inferred from
          density.
        </p>
      ) : !p ? (
        <p className="subtle-note">
          Add a fixed point to sample pressure and generate its trajectory
          history.
        </p>
      ) : (
        <>
          <div className="probe-title">
            <select
              aria-label="Active pressure probe"
              value={c.active}
              onChange={(e) => c.setActive(e.target.value)}
            >
              {c.probes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="small-icon"
              aria-label="Remove pressure probe"
              onClick={c.remove}
            >
              ×
            </button>
          </div>
          <div className="probe-coordinates">
            {p.position.map((v, i) => (
              <label key={i}>
                {"XYZ"[i]}
                <NumberControl
                  aria-label={`Probe ${"XYZ"[i]}`}
                  step="any"
                  value={v}
                  onValueChange={(value) => {
                    if (Number.isFinite(value) && Number.isFinite(value))
                      c.update({
                        position: p.position.map((x, j) =>
                          j === i ? value : x,
                        ),
                      });
                  }}
                />
              </label>
            ))}
          </div>
          <button
            className="text-button"
            disabled={!selectedPosition.length}
            onClick={() => c.update({ position: selectedPosition })}
          >
            Use selected particle position
          </button>
          <label className="probe-radius">
            Sampling radius
            <NumberControl
              aria-label="Probe radius"
              min="0"
              step="any"
              value={p.radius}
              onValueChange={(value) => {
                if (value > 0) c.update({ radius: value });
              }}
            />
          </label>
          <select
            aria-label="Pressure sampling method"
            value={p.method}
            onChange={(e) =>
              c.update({ method: e.target.value as PressureProbe["method"] })
            }
          >
            <option value="idw">Inverse distance · 1/r²</option>
            <option value="nearest">Nearest fluid particle</option>
          </select>
          <dl className="properties">
            <dt>Current pressure</dt>
            <dd>
              {c.current?.values[p.id] != null
                ? formatNumber(c.current.values[p.id]!, 5)
                : "No sample"}
            </dd>
            <dt>History frames</dt>
            <dd>{c.samples.length.toLocaleString()}</dd>
          </dl>
          <button
            className="secondary-button"
            onClick={c.busy ? c.cancel : c.generate}
          >
            {c.busy ? "Cancel history scan" : "Generate pressure histories"}
          </button>
          <p className="subtle-note">
            Fixed in recorded coordinates. Fluid only; stored pressure units.
            Dry regions leave gaps. IDW is approximate, not an SPH kernel.
          </p>
          {c.error && (
            <p className="inline-error" role="alert">
              {c.error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
