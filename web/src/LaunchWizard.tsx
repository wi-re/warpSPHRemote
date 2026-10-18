import {
  classicIntegrators,
  integratorIssue as checkIntegrator,
  dimensionChoices,
  resolutionLimit,
  integratorChoices,
  withoutParameters,
} from "./launchParameters";
import { unsupportedOverrides, type RerunDraft } from "./rerun";
import { videoPlan, videoPlanText, validCadence } from "./recording";
import { memorySize } from "./liveMetrics";
import { NumberControl } from "./NumberControl";
import { useEffect, useState, useRef } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { CompanionClient, type Preset, type Simulation } from "./companion";
import {
  ConfigurationFields,
  activeOverrides,
  schemaDefaults,
  type ParameterSchema,
} from "./ConfigurationFields";
const titles = [
  "Simulation family",
  "Choose a case",
  "Case parameters",
  "Solver and run settings",
];
export function LaunchWizard({
  client,
  presets,
  features,
  runs,
  busy,
  onLaunch,
  initial,
}: {
  client: CompanionClient;
  presets: Preset[];
  features: string[];
  runs: Simulation[];
  busy: boolean;
  onLaunch: (spec: object) => Promise<void>;
  initial?: RerunDraft;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [from, setFrom] = useState(initial?.name);
  const [stepLimit, setStepLimit] = useState<number | undefined>(
    initial?.spec.steps ?? undefined,
  );
  const [step, setStep] = useState(initial ? 3 : 0),
    [family, setFamily] = useState(
      presets.find((p) => p.id === initial?.spec.preset)?.family ?? "",
    ),
    [chosen, setChosen] = useState<Preset | null>(
      presets.find((p) => p.id === initial?.spec.preset) ?? null,
    );
  const [scheme, setScheme] = useState(initial?.spec.scheme ?? ""),
    [variant, setVariant] = useState(initial?.spec.variant ?? ""),
    [nx, setNx] = useState(initial?.spec.nx ?? 128),
    [duration, setDuration] = useState(initial?.spec.duration ?? 3);
  const [record, setRecord] = useState(initial?.spec.record ?? false),
    [interval, setIntervalValue] = useState(
      initial?.spec.exportInterval ?? 0.05,
    );
  const [exportMode, setExportMode] = useState<"time" | "steps">(
      initial?.spec.exportEverySteps !== undefined ? "steps" : "time",
    ),
    [exportEverySteps, setExportEverySteps] = useState(
      initial?.spec.exportEverySteps ?? 10,
    );
  const [videoMode, setVideoMode] = useState<"time" | "steps">(
      initial?.spec.video?.everySteps !== undefined ? "steps" : "time",
    ),
    [videoEverySteps, setVideoEverySteps] = useState(
      initial?.spec.video?.everySteps ?? 10,
    );
  const [measurementInterval, setMeasurementInterval] = useState(
    initial?.spec.diagnosticInterval ?? 0,
  );
  const [measurements, setMeasurements] = useState(
    initial?.spec.measurements ?? false,
  );
  const [startPaused, setStartPaused] = useState(initial?.spec.paused ?? false);
  const [captureVideo, setCaptureVideo] = useState(!!initial?.spec.video),
    [videoFPS, setVideoFPS] = useState(initial?.spec.video?.fps ?? 30),
    [videoInterval, setVideoInterval] = useState(
      initial?.spec.video?.interval ?? 0.04,
    );
  const [schema, setSchema] = useState<ParameterSchema | null>(null),
    [loading, setLoading] = useState(
      !!initial &&
        features.includes("configuration") &&
        chosen?.configurable !== false,
    ),
    [error, setError] = useState("");
  const [params, setParams] = useState<Record<string, any>>(() =>
      structuredClone(initial?.spec.configuration?.params ?? {}),
    ),
    [solver, setSolver] = useState<Record<string, any>>(() =>
      structuredClone(initial?.spec.configuration?.solver ?? {}),
    ),
    [simulation, setSimulation] = useState<Record<string, any>>(() =>
      structuredClone(initial?.spec.configuration?.simulation ?? {}),
    );
  const dimension = simulation.dim ?? chosen?.dimension ?? 2;
  const maxNx = chosen ? resolutionLimit(chosen, dimension) : 512;
  const timestepNames = [
    "integrationScheme",
    "dt",
    "adaptiveDt",
    "cflFactor",
    "minDt",
    "maxDt",
  ];
  const families = [...new Set(presets.map((p) => p.family || "other"))];
  const labels: Record<string, string> = {
    compressible: "Compressible",
    "weakly-compressible": "Weakly compressible",
    incompressible: "Incompressible",
    "free-surface": "Free surface",
    other: "Other cases",
    periodic: "Periodic flows",
    "wall-bounded": "Wall-bounded flows",
  };
  useEffect(() => {
    if (
      !chosen ||
      !features.includes("configuration") ||
      chosen.configurable === false
    ) {
      setSchema(null);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setSchema(null);
    setError("");
    client
      .configuration(
        chosen.id,
        scheme,
        abort.signal,
        chosen.dimensions ? dimension : undefined,
      )
      .then((result) => {
        if (abort.signal.aborted) return;
        setSchema(result.schema || null);
        if (!result.supported)
          setError(
            result.error || "Only preset settings are available for this case.",
          );
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [chosen, scheme, client, features, dimension]);
  function choose(p: Preset) {
    if (chosen?.id === p.id) {
      setStep(2);
      return;
    }
    setFrom(undefined);
    setStepLimit(undefined);
    setChosen(p);
    setScheme(p.schemes[0]);
    setVariant(Object.keys(p.variants)[0]);
    setNx(p.nx);
    setDuration(p.duration);
    setParams({});
    setSolver({});
    setSimulation({});
    setRecord(false);
    setStep(2);
  }
  const properties = schema?.properties;
  const variantConfiguration = chosen?.nativeVariants
    ? (schema as any)?.["x-variants"]?.[variant] || {}
    : { params: chosen?.variants[variant] || {} };
  const defaults = variantConfiguration.params || {};
  const occupied = runs.some(
    (r) =>
      r.createdBy === "daemon" &&
      ["starting", "running", "paused"].includes(r.status),
  );
  const savedIssues =
    from && schema
      ? [
          ...unsupportedOverrides(properties?.params, params, "params"),
          ...unsupportedOverrides(properties?.solver, solver, "solver"),
          ...unsupportedOverrides(
            properties?.simulation,
            simulation,
            "simulation",
          ),
        ]
      : [];
  const awaitingSavedSchema =
    !!from &&
    !schema &&
    [params, solver, simulation].some((v) => Object.keys(v).length > 0);
  const integratorIssue = checkIntegrator(
    properties?.simulation?.properties?.integrationScheme,
    simulation.integrationScheme,
  );
  const invalid =
    !!integratorIssue ||
    savedIssues.length > 0 ||
    awaitingSavedSchema ||
    (stepLimit !== undefined &&
      (!Number.isInteger(stepLimit) ||
        stepLimit < 1 ||
        stepLimit > 10000000)) ||
    !chosen ||
    !Number.isInteger(nx) ||
    nx < 8 ||
    nx > maxNx ||
    !Number.isFinite(duration) ||
    duration < 0.000001 ||
    duration > 10000 ||
    (captureVideo &&
      !validCadence(
        videoFPS,
        videoInterval,
        videoMode === "steps" ? videoEverySteps : undefined,
      )) ||
    (record &&
      (!Number.isFinite(interval) ||
        interval < 1e-6 ||
        interval > 10000 ||
        (exportMode === "steps" &&
          (!Number.isInteger(exportEverySteps) ||
            exportEverySteps < 1 ||
            exportEverySteps > 1e9))));
  const resolvedDuration = chosen?.derivedEndTime ? undefined : duration;
  const targetSteps = stepLimit;
  const initialDT =
    typeof simulation.dt === "number" && simulation.dt > 0
      ? simulation.dt
      : undefined;
  const stepCount =
    targetSteps ??
    (resolvedDuration !== undefined && initialDT
      ? Math.ceil(resolvedDuration / initialDT)
      : undefined);
  const videoSummary =
    videoMode === "steps"
      ? videoPlan(
          videoFPS,
          0,
          stepCount,
          videoEverySteps,
          targetSteps === undefined,
        )
      : videoPlan(videoFPS, 0, resolvedDuration, videoInterval, true);
  const trajectoryFrames =
    exportMode === "steps"
      ? videoPlan(1, 0, stepCount, exportEverySteps).frames
      : videoPlan(1, 0, resolvedDuration, interval).frames;
  const roughFrameBytes = nx ** dimension * (8 * dimension + 24) + 32768;
  const roughTotal =
    trajectoryFrames === undefined
      ? undefined
      : trajectoryFrames * roughFrameBytes;
  return (
    <form
      ref={form}
      className="launch-wizard"
      onSubmit={(e) => e.preventDefault()}
    >
      {from && (
        <p className="capture-estimate" role="status">
          Run again · {from}. Previous launch settings are loaded below. Review
          them, then press Run to start a new simulation.
        </p>
      )}
      {savedIssues.length > 0 && (
        <p role="alert">
          Saved overrides are no longer editable on this daemon:{" "}
          {savedIssues.join(", ")}.{" "}
          <button
            type="button"
            onClick={() => {
              setParams({});
              setSolver({});
              setSimulation({});
            }}
          >
            Reset parameter overrides
          </button>
        </p>
      )}
      {awaitingSavedSchema && !loading && (
        <p role="alert">
          The saved parameter overrides require a configuration schema from this
          daemon. They have been retained; launching is disabled until they can
          be reviewed.
        </p>
      )}
      <nav className="wizard-progress" aria-label="Launch steps">
        {titles.map((t, i) => (
          <button
            type="button"
            key={t}
            disabled={i > step}
            aria-current={i === step ? "step" : undefined}
            onClick={() => setStep(i)}
          >
            {i + 1}. {t}
          </button>
        ))}
      </nav>
      {step > 0 && (
        <button
          type="button"
          className="text-button"
          onClick={() => setStep((s) => s - 1)}
        >
          <ArrowLeft size={15} /> Back
        </button>
      )}
      <h3>{titles[step]}</h3>
      {step === 0 && (
        <div className="family-gallery">
          {families.map((f) => (
            <button
              type="button"
              className="case-card"
              key={f}
              onClick={() => {
                setFamily(f);
                setStep(1);
              }}
            >
              <strong>{labels[f] || f}</strong>
              <small>
                {
                  presets.filter(
                    (p) => (p.family || "other") === f && p.available !== false,
                  ).length
                }{" "}
                available ·{" "}
                {
                  presets.filter(
                    (p) => (p.family || "other") === f && p.available === false,
                  ).length
                }{" "}
                unavailable
              </small>
            </button>
          ))}
        </div>
      )}
      {step === 1 && (
        <>
          <p>
            Cases advertised by {client.endpoint}. Availability and parameter
            support come from its installed solver.
          </p>
          <div className="case-gallery">
            {presets
              .filter((p) => (p.family || "other") === family)
              .map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="case-card"
                  disabled={p.available === false}
                  onClick={() => choose(p)}
                  title={p.unavailableReason || p.description}
                >
                  {p.image ? (
                    <img
                      src={`${import.meta.env.BASE_URL}cases/${p.image}.svg`}
                      alt=""
                    />
                  ) : (
                    <span className="case-placeholder">{p.name}</span>
                  )}
                  <span>{p.name}</span>
                  <small>
                    {p.available === false
                      ? p.unavailableReason
                      : p.configurable
                        ? "Configurable"
                        : "Preset settings"}
                  </small>
                </button>
              ))}
          </div>
        </>
      )}
      {step >= 2 && chosen && (
        <>
          <h4>{chosen.name}</h4>
          <p>{chosen.description}</p>
          <div className="companion-form">
            <label>
              Dimension
              <select
                aria-label="Simulation dimension"
                value={dimension}
                disabled={dimensionChoices(chosen).length === 1 || loading}
                onChange={(e) => {
                  const dim = Number(e.target.value);
                  setSimulation((s) => ({ ...s, dim }));
                  setNx((n) => Math.min(n, resolutionLimit(chosen, dim)));
                }}
              >
                {dimensionChoices(chosen).map((d) => (
                  <option key={d} value={d}>
                    {d}D
                  </option>
                ))}
              </select>
              <small>
                {dimensionChoices(chosen).length === 1
                  ? "Fixed by the installed case sampler."
                  : "Spatial dimensions. Resolution is per axis."}
              </small>
            </label>
            <label>
              Solver
              <select
                value={scheme}
                onChange={(e) => {
                  setScheme(e.target.value);
                  setSolver({});
                }}
              >
                {chosen.schemes.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Variant
              <select
                value={variant}
                onChange={(e) => {
                  setVariant(e.target.value);
                  setParams({});
                  setSolver({});
                  setSimulation((s) =>
                    s.dim === undefined ? {} : { dim: s.dim },
                  );
                }}
              >
                {Object.keys(chosen.variants).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>
          {loading && (
            <p role="status">
              Reading the installed solver’s parameter schema…
            </p>
          )}
          {error && (
            <p className="inline-error" role="status">
              {error}
            </p>
          )}
          {step === 2 && (
            <>
              {properties?.params ? (
                <ConfigurationFields
                  schema={properties.params}
                  value={params}
                  onChange={setParams}
                  scheme={scheme}
                  defaults={defaults}
                />
              ) : (
                !loading && (
                  <p>
                    This case exposes preset variants; individual case
                    parameters are not available from this daemon.
                  </p>
                )
              )}
              <button
                type="button"
                className="primary-button"
                disabled={loading}
                onClick={() => {
                  if (form.current?.reportValidity()) setStep(3);
                }}
              >
                Continue to solver and run settings
              </button>
            </>
          )}
          {step === 3 && (
            <>
              {stepLimit !== undefined && (
                <div className="launch-number-field">
                  <label htmlFor="launch-step-limit">Step limit</label>
                  <NumberControl
                    id="launch-step-limit"
                    aria-label="Step limit"
                    min={1}
                    max={10000000}
                    step={1}
                    value={stepLimit}
                    onValueChange={setStepLimit}
                  />
                  <small>
                    The previous run used a step limit instead of end time.
                  </small>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setStepLimit(undefined)}
                  >
                    Use end time instead
                  </button>
                </div>
              )}
              {properties?.simulation?.properties?.integrationScheme && (
                <section className="launch-number-field">
                  <label htmlFor="launch-timestepper">
                    Timestepper · integration method
                  </label>
                  <select
                    id="launch-timestepper"
                    value={simulation.integrationScheme ?? ""}
                    onChange={(e) =>
                      setSimulation((s) => {
                        const next = { ...s };
                        if (e.target.value)
                          next.integrationScheme = e.target.value;
                        else delete next.integrationScheme;
                        return next;
                      })
                    }
                  >
                    <option value="">
                      Case / variant default ·{" "}
                      {variantConfiguration.simulation?.integrationScheme ??
                        properties.simulation.properties.integrationScheme
                          .default}
                    </option>
                    {integratorChoices(
                      properties.simulation.properties.integrationScheme,
                      simulation.integrationScheme,
                    ).map((v) => (
                      <option key={v} value={v}>
                        {classicIntegrators[v] ?? v}
                      </option>
                    ))}
                  </select>
                  <small>
                    {
                      properties.simulation.properties.integrationScheme
                        .description
                    }
                    . Choose a method, or inherit the case / variant default.
                  </small>
                  {integratorIssue && (
                    <p className="inline-error" role="alert">
                      {integratorIssue}
                    </p>
                  )}
                  <ConfigurationFields
                    schema={{
                      type: "object",
                      properties: Object.fromEntries(
                        Object.entries(properties.simulation.properties).filter(
                          ([k]) =>
                            timestepNames.includes(k) &&
                            k !== "integrationScheme",
                        ),
                      ),
                    }}
                    defaults={variantConfiguration.simulation || {}}
                    value={simulation}
                    onChange={setSimulation}
                    scheme={scheme}
                  />
                </section>
              )}
              <div className="launch-run-controls">
                <section className="launch-number-field">
                  <label htmlFor="launch-resolution">Resolution (nx)</label>
                  <NumberControl
                    id="launch-resolution"
                    aria-label="Resolution (nx)"
                    min={8}
                    max={maxNx}
                    step={1}
                    value={nx}
                    onValueChange={setNx}
                    required
                  />
                  <div
                    className="resolution-presets"
                    role="group"
                    aria-label="Resolution presets"
                  >
                    {[...new Set([32, 64, 128, 256, 512, maxNx])]
                      .filter((n) => n <= maxNx)
                      .map((n) => (
                        <button
                          type="button"
                          key={n}
                          aria-pressed={nx === n}
                          onClick={() => setNx(n)}
                        >
                          {n}
                        </button>
                      ))}
                    <button
                      type="button"
                      onClick={() => setNx(Math.min(chosen.nx, maxNx))}
                    >
                      Default · {Math.min(chosen.nx, maxNx)}
                    </button>
                  </div>
                  <small>
                    {dimension}D · nx per axis; geometry determines the total
                    particle count. Enter any whole number from 8 to {maxNx}, or
                    drag ↕. Hold Shift for finer adjustment.
                  </small>
                </section>
                <section className="launch-number-field">
                  <label htmlFor="launch-duration">End time</label>
                  <NumberControl
                    disabled={chosen.derivedEndTime}
                    id="launch-duration"
                    aria-label="End time"
                    min={0.000001}
                    max={10000}
                    step="any"
                    value={duration}
                    onValueChange={setDuration}
                    required
                  />
                  <small>
                    {chosen.derivedEndTime
                      ? "Derived from case parameters during initialization (for example tauFraction)."
                      : "Simulation time at which to stop the run."}
                  </small>
                </section>
              </div>
              <p>
                Enable an override to change a parameter. Unchecked values
                inherit the case, variant and solver defaults.
              </p>
              {properties?.simulation && (
                <details className="control-disclosure parameter-group launch-parameter-panel">
                  <summary>
                    <span>
                      General simulation parameters
                      <small>Kernel and spatial discretization</small>
                    </span>
                  </summary>
                  <ConfigurationFields
                    schema={withoutParameters(properties.simulation, [
                      "dim",
                      ...timestepNames,
                    ])}
                    defaults={variantConfiguration.simulation || {}}
                    value={simulation}
                    onChange={setSimulation}
                    scheme={scheme}
                  />
                </details>
              )}
              {properties?.solver && (
                <details className="control-disclosure parameter-group launch-parameter-panel">
                  <summary>
                    <span>
                      Numerical solver parameters
                      <small>Diffusion and method-specific controls</small>
                    </span>
                  </summary>
                  <ConfigurationFields
                    schema={properties.solver}
                    defaults={variantConfiguration.solver || {}}
                    value={solver}
                    onChange={setSolver}
                    scheme={scheme}
                  />
                </details>
              )}
              <div className="launch-footer">
                {measurements && (
                  <label>
                    Diagnostic interval · simulation time (0 = automatic)
                    <NumberControl
                      aria-label="Diagnostic interval"
                      value={measurementInterval}
                      min={0}
                      max={10000}
                      step="any"
                      onValueChange={setMeasurementInterval}
                    />
                    <small>
                      Automatic targets about 200 physical samples per run.
                      Resource counters are retained about once per wall second.
                      GPU reductions add some overhead.
                    </small>
                  </label>
                )}
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    disabled={!features.includes("diagnosticRecording")}
                    checked={measurements}
                    onChange={(e) => setMeasurements(e.target.checked)}
                  />
                  Record physical and performance diagnostics (small persistent
                  history)
                </label>
                <div className="recording-controls">
                  {features.includes("recordedHistory") && (
                    <>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={record}
                          onChange={(e) => setRecord(e.target.checked)}
                        />{" "}
                        Record trajectory
                      </label>
                      <small>
                        Off by default. Saves exported frames for replay and
                        uses disk space.
                      </small>
                    </>
                  )}
                  {features.includes("videoFromStart") && (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={startPaused || captureVideo}
                        disabled={captureVideo}
                        onChange={(e) => setStartPaused(e.target.checked)}
                      />
                      Launch paused · configure the initial view before Play
                    </label>
                  )}
                  {features.includes("videoFromStart") && (
                    <>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={captureVideo}
                          onChange={(e) => setCaptureVideo(e.target.checked)}
                        />
                        Capture video from the initial frame
                      </label>
                      <small>
                        Initializes and transfers the first frame, then waits
                        while you configure the visualization. Press Play to
                        record that configured view and begin the simulation.
                        Trajectory recording is separate.
                      </small>
                      {captureVideo && (
                        <div className="launch-video-settings">
                          <div className="launch-number-field">
                            <label htmlFor="launch-video-fps">
                              Video frames per second
                            </label>
                            <NumberControl
                              id="launch-video-fps"
                              aria-label="Video frames per second"
                              value={videoFPS}
                              onValueChange={setVideoFPS}
                              min={1}
                              max={120}
                              step={1}
                              required
                            />
                          </div>
                          <div className="launch-number-field">
                            <label>Capture cadence</label>
                            <select
                              aria-label="Launch video capture cadence"
                              value={videoMode}
                              onChange={(e) =>
                                setVideoMode(e.target.value as "time" | "steps")
                              }
                            >
                              <option value="time">Simulation time</option>
                              <option
                                value="steps"
                                disabled={!features.includes("stepVideo")}
                              >
                                Every N simulation steps
                              </option>
                            </select>
                            <label htmlFor="launch-video-interval">
                              {videoMode === "steps"
                                ? "Simulation steps between video frames"
                                : "Video interval (simulation time)"}
                            </label>
                            <NumberControl
                              id="launch-video-interval"
                              aria-label={
                                videoMode === "steps"
                                  ? "Steps between video frames"
                                  : "Video interval (simulation time)"
                              }
                              value={
                                videoMode === "steps"
                                  ? videoEverySteps
                                  : videoInterval
                              }
                              onValueChange={
                                videoMode === "steps"
                                  ? setVideoEverySteps
                                  : setVideoInterval
                              }
                              min={videoMode === "steps" ? 1 : 0.000001}
                              max={videoMode === "steps" ? 1e9 : 10000}
                              step={videoMode === "steps" ? 1 : "any"}
                              required
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  {captureVideo && (
                    <p className="capture-estimate" role="status">
                      {videoPlanText(videoSummary)} at {videoFPS} fps. First and
                      final frames included.{" "}
                      {videoMode === "steps" && stepCount === undefined
                        ? "A step limit or initialized Δt is needed; the live export panel refines this after startup."
                        : "Adaptive stepping may reduce a time-based capture count."}
                    </p>
                  )}
                  {record && (
                    <div className="launch-number-field">
                      <label>Export cadence</label>
                      <select
                        aria-label="Trajectory export cadence"
                        value={exportMode}
                        onChange={(e) =>
                          setExportMode(e.target.value as "time" | "steps")
                        }
                      >
                        <option value="time">
                          Simulation time (converted to steps at startup)
                        </option>
                        <option
                          value="steps"
                          disabled={!features.includes("recordingEstimates")}
                        >
                          Every N simulation steps
                        </option>
                      </select>
                      <label htmlFor="launch-export-interval">
                        {exportMode === "steps"
                          ? "Steps between trajectory frames"
                          : "Export interval (simulation time)"}
                      </label>
                      <NumberControl
                        id="launch-export-interval"
                        aria-label={
                          exportMode === "steps"
                            ? "Steps between trajectory frames"
                            : "Export interval (simulation time)"
                        }
                        min={exportMode === "steps" ? 1 : 0.000001}
                        max={exportMode === "steps" ? 1e9 : 10000}
                        step={exportMode === "steps" ? 1 : "any"}
                        value={
                          exportMode === "steps" ? exportEverySteps : interval
                        }
                        onValueChange={
                          exportMode === "steps"
                            ? setExportEverySteps
                            : setIntervalValue
                        }
                        required
                      />
                    </div>
                  )}
                </div>
                {occupied && (
                  <p role="status">
                    A managed simulation is already active. Stop it before
                    launching another.
                  </p>
                )}
                {record && (
                  <p className="capture-estimate" role="status">
                    {roughTotal !== undefined
                      ? `Before initialization: roughly ${memorySize(roughTotal * 0.5)}–${memorySize(roughTotal * 3)} for ≈ ${trajectoryFrames?.toLocaleString()} frames.`
                      : "Storage estimate available after initialization."}{" "}
                    Geometry, boundaries and extra fields affect size. The live
                    panel refines this from actual initialized arrays; adaptive
                    Δt changes projected counts.
                  </p>
                )}
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || loading || invalid || occupied}
                  onClick={() =>
                    form.current?.reportValidity() &&
                    void onLaunch({
                      preset: chosen.id,
                      scheme,
                      variant,
                      nx,
                      duration,
                      ...(stepLimit !== undefined ? { steps: stepLimit } : {}),
                      ...(features.includes("videoFromStart")
                        ? { paused: startPaused || captureVideo }
                        : {}),
                      ...(captureVideo && features.includes("videoFromStart")
                        ? {
                            video: {
                              fps: videoFPS,
                              interval: videoInterval,
                              ...(videoMode === "steps"
                                ? { everySteps: videoEverySteps }
                                : {}),
                            },
                          }
                        : {}),
                      ...(measurements
                        ? {
                            measurements: true,
                            ...(measurementInterval > 0
                              ? { diagnosticInterval: measurementInterval }
                              : {}),
                          }
                        : {}),
                      ...(features.includes("recordedHistory")
                        ? {
                            record,
                            exportInterval: interval,
                            ...(record && exportMode === "steps"
                              ? { exportEverySteps }
                              : {}),
                          }
                        : {}),
                      ...(schema
                        ? {
                            configuration: {
                              params: activeOverrides(
                                properties!.params,
                                params,
                                scheme,
                                {
                                  ...schemaDefaults(properties!.params),
                                  ...defaults,
                                },
                              ),
                              solver: activeOverrides(
                                properties!.solver,
                                solver,
                                scheme,
                              ),
                              simulation: activeOverrides(
                                properties!.simulation,
                                simulation,
                                scheme,
                              ),
                            },
                          }
                        : {}),
                    })
                  }
                >
                  <Play size={15} />
                  {busy ? "Validating and starting…" : `Run ${chosen.name}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </form>
  );
}
