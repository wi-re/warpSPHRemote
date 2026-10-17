import { initialLIC, type LICSettings } from "./sources/lic";
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
  lic?: LICSettings;
  settings: GridSettings;
  seeds: number;
  seedMode: "regular" | "picked";
  seed?: number[];
}
export function useFieldView(source: Source | undefined, seed: number[]) {
  const [mode, setMode] = useState<FieldMode>("particles"),
    [flow, setFlow] = useState(false),
    [lic, setLIC] = useState(false),
    [licSettings, setLICSettings] = useState<LICSettings>({ ...initialLIC }),
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
      setLIC(false);
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
    ...(lic && mode !== "particles" ? { lic: licSettings } : {}),
    settings,
    seeds,
    seedMode,
    ...(fixedSeed.length === 2 ? { seed: fixedSeed } : {}),
  };
  const restore = (value: FieldPreferences, sourceId: string) => {
    setMode(value.mode);
    setFlow(value.flow);
    setLIC(!!value.lic && value.mode !== "particles");
    if (value.lic) setLICSettings(value.lic);
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
    lic,
    setLIC,
    licSettings,
    setLICSettings,
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
        lic: lic && mode !== "particles" ? licSettings : undefined,
        seed: flow && seedMode === "picked" ? fixedSeed : undefined,
      };
    },
  };
}
export function FieldControls({
  view: v,
  dimension,
  hasVelocity,
}: {
  view: ReturnType<typeof useFieldView> & {
    result: FieldResult | null;
    busy: boolean;
    error: string;
  };
  dimension: number | undefined;
  hasVelocity: boolean;
  onQuantityChange?: (quantity: GridQuantity) => void;
}) {
  const [gridOpen, setGridOpen] = useState(false),
    [streamsOpen, setStreamsOpen] = useState(false),
    [licOpen, setLICOpen] = useState(false);
  const update = (patch: Partial<GridSettings>) =>
    v.setSettings((old) => ({ ...old, ...patch }));
  if (dimension !== 2)
    return (
      <section className="control-section">
        <p className="subtle-note">
          Grid and flow views currently support 2D recordings.
        </p>
      </section>
    );
  return (
    <>
      <section className="control-section">
        <label className="control-label" htmlFor="field-view">
          Display
        </label>
        <select
          id="field-view"
          value={v.mode}
          onChange={(e) => {
            v.setMode(e.target.value as FieldMode);
            if (e.target.value === "particles") v.setLIC(false);
          }}
        >
          <option value="particles">Particles</option>
          <option value="grid">Scalar grid</option>
          <option value="both">Grid + particles</option>
        </select>
      </section>
      <details
        className="control-disclosure control-section"
        open={gridOpen}
        onToggle={(e) => setGridOpen(e.currentTarget.open)}
      >
        <summary>
          <span>Reconstruction grid</span>
          <small>
            {v.settings.resolution} ·{" "}
            {v.settings.kernel === "wendland2" ? "C2" : "C4"}
          </small>
        </summary>
        <label className="control-label" htmlFor="grid-resolution">
          Grid resolution · longest side
        </label>
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
            <option key={n}>{n}</option>
          ))}
        </select>
        <label className="control-label" htmlFor="grid-kernel">
          Reconstruction kernel
        </label>
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
        <label className="control-label" htmlFor="coverage">
          Minimum fluid coverage
        </label>
        <input
          className="slider"
          id="coverage"
          type="range"
          min="0.05"
          max="0.95"
          step="0.05"
          value={v.settings.minCoverage}
          onChange={(e) => update({ minCoverage: +e.target.value })}
        />
        <p className="subtle-note">
          {v.settings.minCoverage.toFixed(2)} · Volume weighted, Shepard
          normalized. Supports are cutoff radii; dry regions stay transparent.
        </p>
      </details>
      <details
        className="control-disclosure control-section"
        open={streamsOpen}
        onToggle={(e) => setStreamsOpen(e.currentTarget.open)}
      >
        <summary>
          <label>
            <input
              type="checkbox"
              aria-label="Show instantaneous streamlines"
              checked={v.flow}
              disabled={!hasVelocity}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                v.setFlow(e.target.checked);
                setStreamsOpen(e.target.checked);
              }}
            />
            Streamlines
          </label>
          <small>{v.flow ? "On" : "Off"}</small>
        </summary>
        <label className="control-label" htmlFor="stream-seed-mode">
          Streamline seeds
        </label>
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
        {v.seedMode === "regular" ? (
          <>
            <label className="control-label" htmlFor="stream-seeds">
              Seeds per axis · {v.seeds}
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
          </>
        ) : (
          <p className="subtle-note">
            Pick a particle to set a fixed spatial seed.
          </p>
        )}
        <p className="subtle-note">
          One frozen velocity frame. Use material tracks for temporal paths.
        </p>
      </details>
      <details
        className="control-disclosure control-section"
        open={licOpen}
        onToggle={(e) => setLICOpen(e.currentTarget.open)}
      >
        <summary>
          <label>
            <input
              type="checkbox"
              aria-label="Show LIC"
              checked={v.lic}
              disabled={!hasVelocity}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                v.setLIC(e.target.checked);
                setLICOpen(e.target.checked);
                if (e.target.checked && v.mode === "particles")
                  v.setMode("grid");
              }}
            />
            Line integral convolution
          </label>
          <small>{v.lic ? "On" : "Off"}</small>
        </summary>
        <label className="control-label" htmlFor="lic-length">
          LIC half-length · {v.licSettings.steps} cells
        </label>
        <input
          id="lic-length"
          className="slider"
          type="range"
          min="4"
          max="32"
          step="1"
          value={v.licSettings.steps}
          onChange={(e) =>
            v.setLICSettings({ ...v.licSettings, steps: +e.target.value })
          }
        />
        <label className="control-label" htmlFor="lic-contrast">
          LIC contrast
        </label>
        <input
          id="lic-contrast"
          className="slider"
          type="range"
          min=".5"
          max="4"
          step=".1"
          value={v.licSettings.contrast}
          onChange={(e) =>
            v.setLICSettings({ ...v.licSettings, contrast: +e.target.value })
          }
        />
        <label className="control-label" htmlFor="lic-seed">
          LIC noise seed
        </label>
        <input
          id="lic-seed"
          type="number"
          min="0"
          max="65535"
          value={v.licSettings.seed}
          onChange={(e) => {
            const n = +e.target.value;
            if (Number.isInteger(n) && n >= 0 && n <= 65535)
              v.setLICSettings({ ...v.licSettings, seed: n });
          }}
        />
        <p className="subtle-note">
          Instantaneous flow texture; fixed noise in grid coordinates.
          Stagnant/dry regions are masked.
        </p>
      </details>
      <section className="control-section compute-status">
        {v.busy && (
          <p className="subtle-note" role="status">
            Updating grid · keeping the completed frame…
          </p>
        )}
        {v.error && (
          <p className="inline-error" role="alert">
            {v.error}
          </p>
        )}
        {v.result && (
          <p className="subtle-note">
            {v.result.grid.compute?.backend === "webgpu" ? "WebGPU" : "CPU"} ·{" "}
            {v.result.grid.compute?.milliseconds.toFixed(1)} ms reconstruction
            <br />
            {v.result.lic && (
              <>
                LIC {v.result.lic.backend} ·{" "}
                {v.result.lic.milliseconds.toFixed(1)} ms
                <br />
              </>
            )}
            {v.result.grid.width} × {v.result.grid.height} cells ·{" "}
            {v.result.lines.length / 6} streamline segments
            {v.result.grid.compute?.reason && (
              <>
                <br />
                {v.result.grid.compute.reason}
              </>
            )}
          </p>
        )}
      </section>
    </>
  );
}
