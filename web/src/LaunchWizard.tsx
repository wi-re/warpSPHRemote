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
}: {
  client: CompanionClient;
  presets: Preset[];
  features: string[];
  runs: Simulation[];
  busy: boolean;
  onLaunch: (spec: object) => Promise<void>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0),
    [family, setFamily] = useState(""),
    [chosen, setChosen] = useState<Preset | null>(null);
  const [scheme, setScheme] = useState(""),
    [variant, setVariant] = useState(""),
    [nx, setNx] = useState(128),
    [duration, setDuration] = useState(3);
  const [record, setRecord] = useState(false),
    [interval, setIntervalValue] = useState(0.05);
  const [schema, setSchema] = useState<ParameterSchema | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [params, setParams] = useState<Record<string, any>>({}),
    [solver, setSolver] = useState<Record<string, any>>({}),
    [simulation, setSimulation] = useState<Record<string, any>>({});
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
      .configuration(chosen.id, scheme, abort.signal)
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
  }, [chosen, scheme, client, features]);
  function choose(p: Preset) {
    if (chosen?.id === p.id) {
      setStep(2);
      return;
    }
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
  const invalid =
    !chosen ||
    !Number.isInteger(nx) ||
    nx < 8 ||
    nx > (chosen.maxNx ?? 512) ||
    !Number.isFinite(duration) ||
    duration < 0.000001 ||
    duration > 10000 ||
    (record &&
      (!Number.isFinite(interval) || interval < 0.000001 || interval > 10000));
  return (
    <form
      ref={form}
      className="launch-wizard"
      onSubmit={(e) => e.preventDefault()}
    >
      <nav className="wizard-progress" aria-label="Launch steps">
        {titles.map((t, i) => (
          <button
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
        <button className="text-button" onClick={() => setStep((s) => s - 1)}>
          <ArrowLeft size={15} /> Back
        </button>
      )}
      <h3>{titles[step]}</h3>
      {step === 0 && (
        <div className="family-gallery">
          {families.map((f) => (
            <button
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
                  setSimulation({});
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
              <div className="companion-form">
                <label>
                  Resolution (nx)
                  <input
                    type="number"
                    min={8}
                    max={chosen.maxNx ?? 512}
                    step={1}
                    value={nx}
                    onChange={(e) => setNx(+e.target.value)}
                  />
                </label>
                <label>
                  End time
                  <input
                    type="number"
                    min={0.000001}
                    max={10000}
                    step="any"
                    value={duration}
                    onChange={(e) => setDuration(+e.target.value)}
                  />
                </label>
              </div>
              <p>
                Enable an override to change a parameter. Unchecked values
                inherit the case, variant and solver defaults.
              </p>
              {properties?.simulation && (
                <details>
                  <summary>General simulation parameters</summary>
                  <ConfigurationFields
                    schema={properties.simulation}
                    defaults={variantConfiguration.simulation || {}}
                    value={simulation}
                    onChange={setSimulation}
                    scheme={scheme}
                  />
                </details>
              )}
              {properties?.solver && (
                <details>
                  <summary>Numerical solver parameters</summary>
                  <ConfigurationFields
                    schema={properties.solver}
                    defaults={variantConfiguration.solver || {}}
                    value={solver}
                    onChange={setSolver}
                    scheme={scheme}
                  />
                </details>
              )}
              {features.includes("recordedHistory") && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={record}
                    onChange={(e) => setRecord(e.target.checked)}
                  />{" "}
                  Record trajectory (off by default; uses disk space)
                </label>
              )}
              {record && (
                <label>
                  Export interval (simulation time)
                  <input
                    type="number"
                    min={0.000001}
                    max={10000}
                    step="any"
                    value={interval}
                    onChange={(e) => setIntervalValue(+e.target.value)}
                  />
                </label>
              )}
              {occupied && (
                <p role="status">
                  A managed simulation is already active. Stop it before
                  launching another.
                </p>
              )}
              <button
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
                    ...(features.includes("recordedHistory")
                      ? { record, exportInterval: interval }
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
            </>
          )}
        </>
      )}
    </form>
  );
}
