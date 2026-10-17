import { useEffect, useState } from "react";
import type { Mapping, Source } from "./types";
import type { TrajectorySource } from "./sources/client";
import {
  initialGrid,
  type FieldResult,
  type GridSettings,
  categoricalField,
} from "./sources/grid";
export type FieldMode = "particles" | "grid" | "both";
export function useFieldView(
  reader: TrajectorySource | undefined,
  source: Source | undefined,
  index: number,
  field: string,
  mapping: Mapping,
  wrapPeriodic: boolean,
  seed: number[],
) {
  const [mode, setMode] = useState<FieldMode>("particles"),
    [flow, setFlow] = useState(false),
    [settings, setSettings] = useState(initialGrid),
    [seeds, setSeeds] = useState(8),
    [seedMode, setSeedMode] = useState<"regular" | "picked">("regular");
  const [result, setResult] = useState<FieldResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = source?.dimension === 2 && (mode !== "particles" || flow);
  const [pickedSeed, setPickedSeed] = useState<{
    sourceId: string;
    position: number[];
  } | null>(null);
  const inputSeedKey = JSON.stringify(seed);
  useEffect(() => {
    if (source && seed.length === 2)
      setPickedSeed({ sourceId: source.id, position: [...seed] });
  }, [source?.id, inputSeedKey]);
  const fixedSeed =
    seed.length === 2
      ? seed
      : pickedSeed && pickedSeed.sourceId === source?.id
        ? pickedSeed.position
        : [];
  const seedKey = seedMode === "picked" ? JSON.stringify(fixedSeed) : "";
  useEffect(() => {
    setResult(null);
    setError("");
    setBusy(false);
    if (!active || !reader) return;
    if (categoricalField(field)) {
      setError(
        "Select a continuous scalar or vector quantity for reconstruction.",
      );
      return;
    }
    if (flow && seedMode === "picked" && fixedSeed.length !== 2) {
      setError(
        "Pick a particle to seed an instantaneous streamline, or choose regular seeds.",
      );
      return;
    }
    const abort = new AbortController();
    setBusy(true);
    reader
      .grid(
        {
          index,
          field,
          mapping,
          settings: { ...settings, wrapPeriodic },
          streams: flow ? { seeds, steps: 400 } : null,
          seed: flow && seedMode === "picked" ? fixedSeed : undefined,
        },
        abort.signal,
      )
      .then((r) => {
        if (!abort.signal.aborted) setResult(r);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [
    reader,
    source?.id,
    active,
    index,
    field,
    mapping,
    wrapPeriodic,
    settings,
    flow,
    seeds,
    seedMode,
    seedKey,
  ]);
  return {
    mode,
    setMode,
    flow,
    setFlow,
    settings,
    setSettings,
    seeds,
    setSeeds,
    seedMode,
    setSeedMode,
    result,
    busy,
    error,
    active,
  };
}
export function FieldControls({
  view: v,
  dimension,
}: {
  view: ReturnType<typeof useFieldView>;
  dimension: number | undefined;
}) {
  const update = (patch: Partial<GridSettings>) =>
    v.setSettings((old) => ({ ...old, ...patch }));
  return (
    <section className="control-section field-controls">
      <div className="section-heading">FIELD VIEW</div>
      {dimension !== 2 ? (
        <p className="subtle-note">
          Grid fields and streamlines currently support 2D recordings.
        </p>
      ) : (
        <>
          <label className="control-label" htmlFor="field-view">
            Display
          </label>
          <div className="select-wrap">
            <select
              id="field-view"
              value={v.mode}
              onChange={(e) => v.setMode(e.target.value as FieldMode)}
            >
              <option value="particles">Particles</option>
              <option value="grid">Scalar grid</option>
              <option value="both">Grid + particles</option>
            </select>
          </div>
          <label className="flow-toggle">
            <input
              type="checkbox"
              aria-label="Show instantaneous streamlines"
              checked={v.flow}
              onChange={(e) => v.setFlow(e.target.checked)}
            />
            Instantaneous streamlines
          </label>
          {(v.mode !== "particles" || v.flow) && (
            <>
              <label className="control-label" htmlFor="grid-resolution">
                Grid resolution · longest side
              </label>
              <div className="select-wrap">
                <select
                  id="grid-resolution"
                  value={v.settings.resolution}
                  onChange={(e) =>
                    update({
                      resolution: +e.target.value as GridSettings["resolution"],
                    })
                  }
                >
                  {[128, 256, 512].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <label className="control-label" htmlFor="grid-kernel">
                Reconstruction kernel
              </label>
              <div className="select-wrap">
                <select
                  id="grid-kernel"
                  value={v.settings.kernel}
                  onChange={(e) =>
                    update({ kernel: e.target.value as GridSettings["kernel"] })
                  }
                >
                  <option value="wendland2">Wendland C2</option>
                  <option value="wendland4">Wendland C4</option>
                </select>
              </div>
              <label className="control-label" htmlFor="coverage">
                Minimum fluid coverage
              </label>
              <input
                id="coverage"
                className="slider"
                type="range"
                min="0.05"
                max="0.95"
                step="0.05"
                value={v.settings.minCoverage}
                onChange={(e) => update({ minCoverage: +e.target.value })}
              />
              <p className="subtle-note">
                {v.settings.minCoverage.toFixed(2)} · Volume-weighted, Shepard
                normalized. Supports are cutoff radii. Dry regions stay
                transparent.
              </p>
            </>
          )}
          {v.flow && (
            <>
              <label className="control-label" htmlFor="stream-seed-mode">
                Streamline seeds
              </label>
              <div className="select-wrap">
                <select
                  id="stream-seed-mode"
                  value={v.seedMode}
                  onChange={(e) =>
                    v.setSeedMode(e.target.value as "regular" | "picked")
                  }
                >
                  <option value="regular">Regular seed grid</option>
                  <option value="picked">Picked position · fixed seed</option>
                </select>
              </div>
              {v.seedMode === "picked" && (
                <p className="subtle-note">
                  Pick a particle to set a spatial seed. The seed stays fixed
                  while stepping; temporal UID tracks are separate.
                </p>
              )}
              {v.seedMode === "regular" && (
                <>
                  <label className="control-label" htmlFor="stream-seeds">
                    Seeds per axis
                  </label>
                  <input
                    id="stream-seeds"
                    className="slider"
                    type="range"
                    min="2"
                    max="16"
                    step="1"
                    value={v.seeds}
                    onChange={(e) => v.setSeeds(+e.target.value)}
                  />
                  <p className="subtle-note">
                    {v.seeds} × {v.seeds} seeds · One frozen velocity frame. For
                    temporal paths use particle traces.
                  </p>
                </>
              )}
            </>
          )}
          {v.busy && (
            <p className="subtle-note" role="status">
              Reconstructing field…
            </p>
          )}
          {v.error && (
            <p className="inline-error" role="alert">
              {v.error}
            </p>
          )}
          {v.result && (
            <p className="subtle-note">
              {v.result.grid.width} × {v.result.grid.height} cells ·{" "}
              {v.result.lines.length / 6} streamline segments
              {v.result.grid.excluded
                ? ` · ${v.result.grid.excluded} invalid-volume particles excluded`
                : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
