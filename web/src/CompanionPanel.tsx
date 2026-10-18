import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Link2,
  Play,
  Pause,
  History,
  Radio,
  Square,
  Unplug,
  X,
} from "lucide-react";
import {
  CompanionClient,
  companionConnectionMessage,
  CompanionHTTPError,
  canPauseSimulation,
  type SimulationControl,
  LiveSource,
  RecordedSource,
  takePairing,
  type Preset,
  type Simulation,
} from "./companion";
import {
  recallPairing,
  rememberPairing,
  forgetPairing,
  samePairingEndpoint,
} from "./pairing";
import type { TrajectorySource } from "./sources/client";
import { formatNumber } from "./data";

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  sourceId: string;
  onFrame: (reader: TrajectorySource, first: boolean) => void;
  onDetached: (id: string) => void;
  onControl: (control: SimulationControl | null) => void;
}
export function CompanionPanel({
  open,
  onOpen,
  onClose,
  sourceId,
  onFrame,
  onDetached,
  onControl,
}: Props) {
  const [saved, setSaved] = useState(recallPairing);
  const [remember, setRemember] = useState(true);
  const [storageMessage, setStorageMessage] = useState("");
  const [endpoint, setEndpoint] = useState(
      saved?.endpoint ?? "http://127.0.0.1:8766",
    ),
    [token, setToken] = useState(saved?.token ?? "");
  const [client, setClient] = useState<CompanionClient | null>(null),
    [presets, setPresets] = useState<Preset[]>([]);
  const [runs, setRuns] = useState<Simulation[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(""),
    [notice, setNotice] = useState<Simulation | null>(null);
  const [presetId, setPresetId] = useState("gresho"),
    [scheme, setScheme] = useState("CRKSPH"),
    [variant, setVariant] = useState("standard");
  const [showEnded, setShowEnded] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const controlRequest = useRef("");
  const [features, setFeatures] = useState<string[]>([]);
  const [record, setRecord] = useState(false);
  const [exportInterval, setExportInterval] = useState(0.05);
  const historySession = useRef<AbortController | null>(null);
  const [nx, setNx] = useState(128),
    [duration, setDuration] = useState(3);
  const active = useRef<{
    id: string;
    client: CompanionClient;
    abort: AbortController;
    reader?: LiveSource;
    waiting: boolean;
  } | null>(null);
  const connection = useRef<AbortController | null>(null);
  const callbacks = useRef({
    onFrame,
    onDetached,
    sourceId,
    onOpen,
    onControl,
    connect,
  });
  callbacks.current = {
    onFrame,
    onDetached,
    sourceId,
    onOpen,
    onControl,
    connect,
  };
  const known = useRef<Set<string> | null>(null);
  const preset = presets.find((p) => p.id === presetId);
  async function connect(address = endpoint, secret = token) {
    connection.current?.abort();
    const attempt = new AbortController();
    connection.current = attempt;
    setBusy(true);
    setError("");
    try {
      const next = new CompanionClient(address, secret.trim()),
        session = await next.session(attempt.signal);
      if (connection.current !== attempt || attempt.signal.aborted) return;
      setPresets(session.presets);
      setFeatures(session.features || []);
      known.current = null;
      setClient(next);
      if (remember) {
        const value = { endpoint: next.endpoint, token: secret.trim() };
        if (rememberPairing(value)) {
          setSaved(value);
          setStorageMessage("");
        } else
          setStorageMessage(
            "Browser storage is unavailable; pairing is kept only in this tab.",
          );
      }
    } catch (error) {
      if (connection.current === attempt && !attempt.signal.aborted) {
        setError(companionConnectionMessage(error));
        if (
          error instanceof CompanionHTTPError &&
          error.status === 401 &&
          saved &&
          saved.token === secret.trim() &&
          samePairingEndpoint(saved, address)
        ) {
          forgetPairing();
          setSaved(null);
        }
      }
    } finally {
      if (connection.current === attempt) {
        connection.current = null;
        setBusy(false);
      }
    }
  }
  async function togglePause(run: Simulation) {
    if (!client || controlRequest.current || !canPauseSimulation(run, features))
      return;
    const next = !run.pauseRequested;
    controlRequest.current = run.id;
    setControlBusy(run.id);
    try {
      await client.pause(run.id, next);
      setRuns((old) =>
        old.map((row) =>
          row.id === run.id ? { ...row, pauseRequested: next } : row,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
      callbacks.current.onOpen();
    } finally {
      controlRequest.current = "";
      setControlBusy("");
    }
  }
  useEffect(() => {
    const run = runs.find((row) => row.id === attached);
    callbacks.current.onControl(
      run && client
        ? {
            sourceId: `live-${run.id}`,
            status: run.status,
            pauseRequested: !!run.pauseRequested,
            canPause: canPauseSimulation(run, features),
            busy: !!controlBusy,
            toggle: () => void togglePause(run),
          }
        : null,
    );
  }, [runs, attached, client, features, controlBusy]);
  async function forgetSavedPairing() {
    cancelConnection();
    const removed = forgetPairing();
    setSaved(null);
    setRemember(false);
    setStorageMessage(
      removed
        ? ""
        : "Browser storage could not be cleared. Clear this site's storage in your browser to forget pairing.",
    );
    await detach();
    historySession.current?.abort();
    setClient(null);
    setToken("");
    setRuns([]);
  }
  function cancelConnection() {
    const attempt = connection.current;
    if (!attempt) return;
    connection.current = null;
    attempt.abort();
    setBusy(false);
  }
  function closePanel() {
    cancelConnection();
    onClose();
  }
  useEffect(() => {
    const consume = () => {
      const pairing = takePairing(window.location, (url) =>
        history.replaceState(null, "", url),
      );
      if (!pairing) return;
      setEndpoint(pairing.endpoint);
      setToken(pairing.token);
      callbacks.current.onOpen();
      void detach().then(() =>
        callbacks.current.connect(pairing.endpoint, pairing.token),
      );
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, []);
  async function detach() {
    const previous = active.current;
    if (!previous) return;
    active.current = null;
    previous.abort.abort();
    setAttached("");
    callbacks.current.onDetached(`live-${previous.id}`);
    try {
      await previous.client.detach(previous.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const list = await client!.runs(abort.signal);
        if (stopped) return;
        if (known.current) {
          const fresh = list.filter((r) => !known.current!.has(r.id)).at(-1);
          if (fresh) setNotice(fresh);
        }
        known.current = new Set(list.map((r) => r.id));
        setRuns(list);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [client]);
  useEffect(() => {
    if (!attached) return;
    const current = active.current;
    if (current?.reader && sourceId !== `live-${attached}`) void detach();
  }, [sourceId]);
  useEffect(() => {
    const release = () => {
      const current = active.current;
      active.current = null;
      current?.abort.abort();
      if (current) void current.client.detach(current.id, true).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      connection.current?.abort();
      historySession.current?.abort();
      connection.current = null;
      release();
    };
  }, []);
  async function attach(id: string) {
    historySession.current?.abort();
    if (!client) return;
    setBusy(true);
    setError("");
    await detach();
    try {
      await client.attach(id);
      const session = {
        id,
        client,
        abort: new AbortController(),
        reader: undefined as LiveSource | undefined,
        waiting: false,
      };
      active.current = session;
      setAttached(id);
      setNotice(null);
      onClose();
      // Lease renewal carries no particle data, even while a costly grid is being rendered.
      const heartbeat = setInterval(() => {
        void client
          .request(`/v1/runs/${id}/attach`, {}, session.abort.signal)
          .catch((e) => {
            if (!session.abort.signal.aborted) setError(e.message);
          });
      }, 5000);
      const pump = async () => {
        try {
          while (!session.abort.signal.aborted) {
            if (!session.waiting) {
              const snapshot = await client.snapshot(id, session.abort.signal);
              if (snapshot) {
                session.waiting = true;
                const ack = async () => {
                  if (active.current !== session) return;
                  await client.ack(id, snapshot.sequence);
                  session.waiting = false;
                };
                const first = !session.reader;
                if (session.reader) session.reader.update(snapshot, ack);
                else session.reader = new LiveSource(snapshot, ack);
                callbacks.current.onFrame(session.reader, first);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (e) {
          if (!session.abort.signal.aborted) {
            setError((e as Error).message);
            callbacks.current.onOpen();
          }
        } finally {
          clearInterval(heartbeat);
        }
      };
      void pump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function viewHistory(id: string) {
    if (!client) return;
    setBusy(true);
    setError("");
    historySession.current?.abort();
    const abort = new AbortController();
    historySession.current = abort;
    await detach();
    try {
      const metadata = await client.recording(id, abort.signal);
      const reader = new RecordedSource(metadata, client, id);
      callbacks.current.onFrame(reader, true);
      onClose();
      const refresh = async () => {
        if (abort.signal.aborted || callbacks.current.sourceId !== metadata.id)
          return;
        try {
          const changed = await reader.refresh(abort.signal);
          if (changed && !abort.signal.aborted)
            callbacks.current.onFrame(reader, false);
        } catch (e) {
          if (!abort.signal.aborted) setError((e as Error).message);
        }
        if (!abort.signal.aborted) setTimeout(refresh, 2000);
      };
      setTimeout(refresh, 2000);
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selectPreset(p: Preset) {
    setPresetId(p.id);
    setScheme(p.schemes[0]);
    setVariant(Object.keys(p.variants)[0]);
    setNx(p.nx);
    setDuration(p.duration);
  }
  async function launch() {
    if (!client || !preset) return;
    setBusy(true);
    setError("");
    try {
      const run = await client.launch({
        preset: preset.id,
        scheme,
        variant,
        nx,
        duration,
        ...(features.includes("recordedHistory")
          ? { record, exportInterval }
          : {}),
      });
      setNotice(run);
      setRuns((old) => [...old, run]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {notice && !open && (
        <div className="companion-notice" role="status">
          <Radio size={16} />
          <span>
            New simulation: <strong>{notice.name}</strong>
          </span>
          <button onClick={onOpen}>View simulations</button>
          <button
            aria-label="Dismiss simulation notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {open && (
        <div className="modal-backdrop" onClick={closePanel}>
          <section
            className="modal companion-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Local simulations"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="companion-heading">
              <div>
                <div className="eyebrow">LOCAL COMPANION</div>
                <h2>Your simulations</h2>
                <p>
                  Run familiar cases, inspect progress and attach this viewer.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Close local simulations"
                onClick={closePanel}
              >
                <X size={20} />
              </button>
            </header>
            {error && (
              <div className="companion-error" role="alert">
                <span>{error}</span>
                <button
                  onClick={() => setError("")}
                  aria-label="Dismiss companion error"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!client ? (
              <section className="companion-connect">
                <h3>Connect to this device</h3>
                <p>
                  Start the companion in your warpSPH environment. Copy the
                  pairing token printed in the terminal.
                </p>
                <pre>warpsph-companion --python /path/to/warp/bin/python</pre>
                <div className="companion-form">
                  <label>
                    Address
                    <input
                      value={endpoint}
                      onChange={(e) => {
                        const address = e.target.value;
                        if (
                          saved &&
                          token === saved.token &&
                          !samePairingEndpoint(saved, address)
                        )
                          setToken("");
                        setEndpoint(address);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Pairing token
                    <input
                      type="password"
                      disabled={busy}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={busy || !token}
                    onClick={() => void connect()}
                  >
                    <Link2 size={15} /> {busy ? "Connecting…" : "Connect"}
                  </button>
                  {busy && (
                    <button
                      className="secondary-button"
                      onClick={cancelConnection}
                    >
                      Cancel connection
                    </button>
                  )}
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={remember}
                    disabled={busy}
                    onChange={(e) => {
                      setRemember(e.target.checked);
                      if (!e.target.checked) {
                        if (forgetPairing()) {
                          setSaved(null);
                          setStorageMessage("");
                        } else
                          setStorageMessage(
                            "Browser storage could not be cleared. Clear this site's storage in your browser to forget pairing.",
                          );
                      }
                    }}
                  />
                  Remember pairing on this browser
                </label>
                {saved && (
                  <button
                    className="text-button"
                    onClick={() => void forgetSavedPairing()}
                  >
                    Forget pairing
                  </button>
                )}
                {storageMessage && <p role="status">{storageMessage}</p>}
                {busy && (
                  <p role="status">
                    Waiting for the companion or your browser’s access
                    permission. Click Allow if prompted; this attempt can wait
                    up to one minute.
                  </p>
                )}
                <details>
                  <summary>Open through the desktop launcher</summary>
                  <p>Install once in your simulation environment:</p>
                  <pre>warpsph-remote-open --install-xdg</pre>
                  <a className="secondary-button" href="warpsph://connect">
                    Start local companion
                  </a>
                  <p>
                    The launcher opens a paired viewer tab. Your browser may ask
                    permission to open the desktop app and access localhost.
                  </p>
                </details>
                <small>
                  Remembered pairing stays in this browser's site storage.
                  Restarting the companion rotates its token. The companion
                  listens only on localhost.
                </small>
              </section>
            ) : (
              <>
                <div className="companion-connection">
                  <span className="tiny-dot" /> Connected · {client.endpoint}
                  <button
                    onClick={async () => {
                      await detach();
                      historySession.current?.abort();
                      setClient(null);
                      setRuns([]);
                    }}
                  >
                    Disconnect
                  </button>
                  <button onClick={() => void forgetSavedPairing()}>
                    Forget pairing
                  </button>
                  {storageMessage && (
                    <small role="status">{storageMessage}</small>
                  )}
                </div>
                <section className="companion-runs">
                  <div className="section-heading">
                    <Activity size={15} /> RESIDENT SIMULATIONS{" "}
                    <small>{runs.length}</small>
                  </div>
                  {!runs.length && (
                    <p className="empty-hint">
                      No simulations yet. Launch a preset below, or register a
                      simulation with <code>run_live(case, …)</code>.
                    </p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setShowEnded((v) => !v)}
                  >
                    {showEnded
                      ? "Hide finished simulations"
                      : `Show ${runs.filter((r) => !["running", "starting", "paused"].includes(r.status)).length} finished simulations`}
                  </button>
                  {runs
                    .filter(
                      (run) =>
                        showEnded ||
                        run.id === attached ||
                        ["running", "starting", "paused"].includes(run.status),
                    )
                    .sort(
                      (a, b) =>
                        Number(
                          ["running", "starting", "paused"].includes(b.status),
                        ) -
                          Number(
                            ["running", "starting", "paused"].includes(
                              a.status,
                            ),
                          ) || b.startedAt - a.startedAt,
                    )
                    .map((run) => (
                      <article className="companion-run" key={run.id}>
                        <div>
                          <strong>{run.name}</strong>
                          <span className={`run-state ${run.status}`}>
                            {run.status}
                            {run.stale ? " · no recent heartbeat" : ""}
                            {attached === run.id ? " · attached" : ""}
                          </span>
                          <small>
                            {new Date(
                              run.startedAt * 1000,
                            ).toLocaleTimeString()}{" "}
                            · PID {run.pid ?? "—"} ·{" "}
                            {run.scheme ?? "initializing"}
                          </small>
                          <div className="run-numbers">
                            <span>
                              Particles{" "}
                              <b>{run.particles?.toLocaleString() ?? "—"}</b>
                            </span>
                            <span>
                              Time{" "}
                              <b>
                                {run.time == null
                                  ? "—"
                                  : formatNumber(run.time, 5)}
                              </b>
                            </span>
                            <span>
                              Step <b>{run.step ?? "—"}</b>
                            </span>
                            <span>
                              Δt{" "}
                              <b>
                                {run.dt == null ? "—" : formatNumber(run.dt, 4)}
                              </b>
                            </span>
                          </div>
                          {run.message && (
                            <small className="inline-error">
                              {run.message}
                            </small>
                          )}
                        </div>
                        <div className="run-actions">
                          {attached === run.id ? (
                            <button
                              className="secondary-button"
                              onClick={() => void detach()}
                            >
                              <Unplug size={14} /> Detach
                            </button>
                          ) : (
                            <button
                              className="primary-button"
                              disabled={
                                busy ||
                                !!controlBusy ||
                                !canPauseSimulation(run, features)
                              }
                              onClick={() => void attach(run.id)}
                            >
                              <Radio size={14} /> Watch live
                            </button>
                          )}
                          {run.recording?.enabled && (
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => void viewHistory(run.id)}
                            >
                              <History size={14} /> View history
                            </button>
                          )}
                          {features.includes("pause") && (
                            <button
                              className="secondary-button"
                              disabled={
                                !run.registered ||
                                !["running", "starting", "paused"].includes(
                                  run.status,
                                )
                              }
                              onClick={() => void togglePause(run)}
                            >
                              {run.pauseRequested ? (
                                <Play size={14} />
                              ) : (
                                <Pause size={14} />
                              )}
                              {run.pauseRequested ? "Resume" : "Pause"}
                              {run.pauseRequested && run.status !== "paused"
                                ? " requested…"
                                : ""}
                            </button>
                          )}
                          <button
                            className="secondary-button"
                            disabled={
                              !["running", "starting", "paused"].includes(
                                run.status,
                              )
                            }
                            onClick={() => {
                              void client
                                .stop(run.id)
                                .catch((e) => setError(e.message));
                            }}
                          >
                            <Square size={12} /> Stop
                          </button>
                        </div>
                      </article>
                    ))}
                  <small>
                    Without an attached viewer, simulations send status only.
                    Live diagnostics sample displayed snapshots (last 600);
                    Recording is optional. View history reads exported frames
                    while the simulation runs or is paused; Watch live returns
                    to current snapshots.
                  </small>
                </section>
                <section className="companion-cases">
                  <div className="section-heading">
                    <Play size={15} /> START A PRESET
                  </div>
                  <p>
                    Uses warpSPH installed with the daemon’s simulation Python.
                    One managed preset runs at a time.
                  </p>
                  <div className="case-gallery">
                    {presets.map((p) => (
                      <button
                        key={p.id}
                        className={
                          presetId === p.id ? "case-card selected" : "case-card"
                        }
                        onClick={() => selectPreset(p)}
                        aria-pressed={presetId === p.id}
                      >
                        <img
                          src={`${import.meta.env.BASE_URL}cases/${p.image}.svg`}
                          alt=""
                        />
                        <span>{p.name}</span>
                        <small>Schematic</small>
                      </button>
                    ))}
                  </div>
                  {preset && (
                    <>
                      <p>{preset.description}</p>
                      <div className="companion-form">
                        <label>
                          Solver
                          <select
                            value={scheme}
                            onChange={(e) => setScheme(e.target.value)}
                          >
                            {preset.schemes.map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Variant
                          <select
                            value={variant}
                            onChange={(e) => setVariant(e.target.value)}
                          >
                            {Object.keys(preset.variants).map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Resolution (nx)
                          <input
                            type="number"
                            min={8}
                            max={preset.maxNx ?? 512}
                            step={8}
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
                            step={0.5}
                            value={duration}
                            onChange={(e) => setDuration(+e.target.value)}
                          />
                        </label>
                      </div>
                      {features.includes("recordedHistory") && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={record}
                            onChange={(e) => setRecord(e.target.checked)}
                          />
                          Record trajectory (uses disk space)
                        </label>
                      )}
                      {features.includes("recordedHistory") && record && (
                        <label>
                          Export interval (simulation time)
                          <input
                            type="number"
                            min={0.000001}
                            max={10000}
                            step={0.01}
                            value={exportInterval}
                            onChange={(e) => setExportInterval(+e.target.value)}
                          />
                        </label>
                      )}
                      <button
                        className="primary-button"
                        disabled={
                          busy ||
                          (record &&
                            (!Number.isFinite(exportInterval) ||
                              exportInterval < 0.000001 ||
                              exportInterval > 10000)) ||
                          !Number.isInteger(nx) ||
                          nx < 8 ||
                          nx > (preset.maxNx ?? 512) ||
                          !Number.isFinite(duration) ||
                          duration <= 0 ||
                          runs.some(
                            (r) =>
                              r.createdBy === "daemon" &&
                              ["starting", "running", "paused"].includes(
                                r.status,
                              ),
                          )
                        }
                        onClick={() => void launch()}
                      >
                        <Play size={15} />{" "}
                        {busy ? "Starting…" : `Run ${preset.name}`}
                      </button>
                    </>
                  )}
                </section>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
