import { readPreferences } from "./preferences";
import { useEffect, useState } from "react";
import type { Mapping, Source } from "./types";
import {
  initialGrid,
  derivativeQuantity,
  gridQuantityLabel,
  type GridQuantity,
  type FieldResult,
  type GridSettings,
  type FieldQuery,
} from "./sources/grid";
export type FieldMode = "particles" | "grid" | "both";
export interface FieldPreferences {
  mode: FieldMode;
  flow: boolean;
  settings: GridSettings;
  seeds: number;
  seedMode: "regular" | "picked";
  seed?: number[];
}
export function useFieldView(source: Source | undefined, seed: number[]) {
  const [mode, setMode] = useState<FieldMode>("particles"),
    [flow, setFlow] = useState(false),
    [settings, setSettings] = useState<GridSettings>(() => ({
      ...initialGrid,
      backend: readPreferences().backend,
    })),
    [seeds, setSeeds] = useState(8),
    [seedMode, setSeedMode] = useState<"regular" | "picked">("regular");
  useEffect(() => {
    if (
      source &&
      !source.fields.some((f) => f.name === "velocities" && f.components >= 2)
    ) {
      if (derivativeQuantity(settings.quantity))
        setSettings((old) => ({ ...old, quantity: "field" }));
      setFlow(false);
    }
  }, [source?.id, settings.quantity]);
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
      : pickedSeed?.sourceId === source?.id
        ? (pickedSeed?.position ?? [])
        : [];
  const preferences: FieldPreferences = {
    mode,
    flow,
    settings,
    seeds,
    seedMode,
    ...(fixedSeed.length === 2 ? { seed: fixedSeed } : {}),
  };
  const restore = (value: FieldPreferences, sourceId: string) => {
    setMode(value.mode);
    setFlow(value.flow);
    setSettings(value.settings);
    setSeeds(value.seeds);
    setSeedMode(value.seedMode);
    setPickedSeed(value.seed ? { sourceId, position: value.seed } : null);
  };
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
    active,
    preferences,
    restore,
    query(
      index: number,
      field: string,
      mapping: Mapping,
      wrapPeriodic: boolean,
    ): FieldQuery | null {
      if (!active) return null;
      return {
        index,
        field:
          mode === "particles" || derivativeQuantity(settings.quantity)
            ? "velocities"
            : field,
        mapping:
          mode === "particles" || derivativeQuantity(settings.quantity)
            ? "magnitude"
            : mapping,
        settings: {
          ...settings,
          wrapPeriodic,
          quantity: mode === "particles" ? "field" : settings.quantity,
        },
        streams: flow ? { seeds, steps: 400 } : null,
        seed: flow && seedMode === "picked" ? fixedSeed : undefined,
      };
    },
  };
}
export function FieldControls({
  view: v,
  dimension,
  hasVelocity,
  onQuantityChange,
}: {
  view: ReturnType<typeof useFieldView> & {
    result: FieldResult | null;
    busy: boolean;
    error: string;
  };
  dimension: number | undefined;
  hasVelocity: boolean;
  onQuantityChange: (quantity: GridQuantity) => void;
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
              disabled={!hasVelocity}
              onChange={(e) => v.setFlow(e.target.checked)}
            />
            Instantaneous streamlines
          </label>
          {(v.mode !== "particles" || v.flow) && (
            <>
              {v.mode !== "particles" && (
                <>
                  <label className="control-label" htmlFor="grid-quantity">
                    Grid quantity
                  </label>
                  <div className="select-wrap">
                    <select
                      id="grid-quantity"
                      value={v.settings.quantity ?? "field"}
                      onChange={(e) => {
                        const quantity = e.target.value as GridQuantity;
                        update({ quantity });
                        onQuantityChange(quantity);
                      }}
                    >
                      <option value="field">Recorded quantity</option>
                      <option value="divergence" disabled={!hasVelocity}>
                        Velocity divergence
                      </option>
                      <option value="vorticity" disabled={!hasVelocity}>
                        Vorticity · out of plane
                      </option>
                    </select>
                  </div>
                  {derivativeQuantity(v.settings.quantity) && (
                    <p className="subtle-note">
                      Analytic derivative of normalized SPH velocity · velocity
                      / length units. Linear and symmetric-log auto ranges are
                      centered on zero. Particle overlays are neutral; picked
                      values remain recorded.
                    </p>
                  )}
                  {!hasVelocity && (
                    <p className="subtle-note">
                      Record velocities to enable divergence and vorticity.
                    </p>
                  )}
                </>
              )}
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
              Updating grid · keeping the last completed frame…
            </p>
          )}
          {v.error && (
            <p className="inline-error" role="alert">
              {v.error}
            </p>
          )}
          {v.result && (
            <p className="subtle-note">
              {derivativeQuantity(v.result.grid.quantity) && (
                <>
                  {gridQuantityLabel(v.result.grid.quantity)}
                  <br />
                </>
              )}
              {v.result.grid.compute && (
                <span title={v.result.grid.compute.adapter}>
                  {v.result.grid.compute.backend === "webgpu"
                    ? "WebGPU"
                    : "CPU"}{" "}
                  · {v.result.grid.compute.milliseconds.toFixed(1)} ms
                  reconstruction
                  <br />
                </span>
              )}
              {v.result.grid.compute?.reason && (
                <span>
                  CPU fallback: {v.result.grid.compute.reason}
                  <br />
                </span>
              )}
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
