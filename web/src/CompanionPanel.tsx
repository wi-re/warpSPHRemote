import { LaunchWizard } from "./LaunchWizard";
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
import { discoverSimulations, recallMonitor, rememberMonitor } from "./monitor";
import type { TrajectorySource } from "./sources/client";
import { formatNumber } from "./data";

interface PendingAttachment {
  run: Simulation;
  client: CompanionClient;
  reason: "launch" | "monitor" | "manual";
}
export type CompanionSection = "connection" | "running" | "history" | "launch";
interface Props {
  section: CompanionSection;
  onConnection: (connected: boolean) => void;
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
  section,
  onConnection,
  onOpen,
  onClose,
  sourceId,
  onFrame,
  onDetached,
  onControl,
}: Props) {
  const backdropPress = useRef(false);
  const [monitor, setMonitor] = useState(recallMonitor);
  const monitorEnabled = useRef(monitor);
  monitorEnabled.current = monitor;
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [awaitingFrame, setAwaitingFrame] = useState<Simulation | null>(null);
  const pendingAttachment = useRef<PendingAttachment | null>(null);
  const attaching = useRef(false);
  const [attachmentRevision, setAttachmentRevision] = useState(0);
  const [saved, setSaved] = useState(recallPairing);
  const [remember, setRemember] = useState(true);
  const [storageMessage, setStorageMessage] = useState("");
  const [endpoint, setEndpoint] = useState(
      saved?.endpoint ?? "http://127.0.0.1:8766",
    ),
    [token, setToken] = useState(saved?.token ?? "");
  const [client, setClient] = useState<CompanionClient | null>(null),
    [presets, setPresets] = useState<Preset[]>([]);
  const connectedClient = useRef(client);
  connectedClient.current = client;
  const [runs, setRuns] = useState<Simulation[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(""),
    [notice, setNotice] = useState<Simulation | null>(null);
  const [controlBusy, setControlBusy] = useState("");
  const controlRequest = useRef("");
  const [features, setFeatures] = useState<string[]>([]);
  const historySession = useRef<AbortController | null>(null);
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
    onClose,
    onControl,
    connect,
    enqueueAttachment,
  });
  callbacks.current = {
    onFrame,
    onDetached,
    sourceId,
    onOpen,
    onClose,
    onControl,
    connect,
    enqueueAttachment,
  };
  const known = useRef<Set<string> | null>(null);
  useEffect(() => onConnection(!!client), [client, onConnection]);
  useEffect(() => {
    if (open && !client && saved && !connection.current && !error)
      void connect(saved.endpoint, saved.token);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !(client && section === "launch")
      )
        closePanel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, client, section]);
  async function connect(address = endpoint, secret = token) {
    connection.current?.abort();
    const attempt = new AbortController();
    connection.current = attempt;
    connectedClient.current = null;
    cancelAttachment();
    setClient(null);
    setRuns([]);
    setBusy(true);
    setError("");
    try {
      const next = new CompanionClient(address, secret.trim()),
        session = await next.session(attempt.signal);
      if (connection.current !== attempt || attempt.signal.aborted) return;
      setPresets(session.presets);
      setFeatures(session.features || []);
      known.current = null;
      connectedClient.current = next;
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
    connectedClient.current = null;
    setClient(null);
    setRuns([]);
    await detach();
    historySession.current?.abort();
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
  function cancelAttachment() {
    pendingAttachment.current = null;
    setPending(null);
  }
  function enqueueAttachment(
    run: Simulation,
    reason: PendingAttachment["reason"],
  ) {
    if (!client || connectedClient.current !== client) return;
    known.current?.add(run.id);
    historySession.current?.abort();
    setNotice(null);
    if (active.current?.id === run.id && active.current.client === client)
      return;
    callbacks.current.onClose();
    const previous = pendingAttachment.current;
    if (previous?.run.id === run.id && previous.client === client) {
      if (reason !== "monitor") previous.reason = reason;
      return;
    }
    const request = { run, client, reason };
    pendingAttachment.current = request;
    setPending(request);
  }
  async function detach() {
    cancelAttachment();
    await detachActive();
  }
  async function detachActive() {
    setAwaitingFrame(null);
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
        if (stopped || connectedClient.current !== client) return;
        const discovered = discoverSimulations(
          list,
          known.current,
          monitorEnabled.current,
        );
        known.current = discovered.known;
        if (discovered.follow)
          callbacks.current.enqueueAttachment(discovered.follow, "monitor");
        else if (
          discovered.notice &&
          pendingAttachment.current?.run.id !== discovered.notice.id &&
          active.current?.id !== discovered.notice.id
        )
          setNotice(discovered.notice);
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
      pendingAttachment.current = null;
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
  useEffect(() => {
    if (
      !pending ||
      pendingAttachment.current !== pending ||
      pending.client !== client ||
      attaching.current
    )
      return;
    const run = runs.find((row) => row.id === pending.run.id) ?? pending.run;
    if (!["starting", "running", "paused"].includes(run.status)) {
      cancelAttachment();
      setError(
        `${run.name}: ${run.message || "The simulation ended before live viewing was ready."}`,
      );
      callbacks.current.onOpen();
      return;
    }
    if (!run.registered) return;
    attaching.current = true;
    void attachPending(pending).finally(() => {
      attaching.current = false;
      setAttachmentRevision((value) => value + 1);
    });
  }, [pending, runs, client, attachmentRevision]);
  async function attach(id: string) {
    const run = runs.find((row) => row.id === id);
    if (run) enqueueAttachment(run, "manual");
  }
  async function attachPending(request: PendingAttachment) {
    const {
      client,
      run: { id },
    } = request;
    historySession.current?.abort();
    setBusy(true);
    setError("");
    try {
      await detachActive();
      if (pendingAttachment.current !== request) return;
      await client.attach(id);
      if (pendingAttachment.current !== request) {
        await client.detach(id).catch(() => {});
        return;
      }
      cancelAttachment();
      const session = {
        id,
        client,
        abort: new AbortController(),
        reader: undefined as LiveSource | undefined,
        waiting: false,
      };
      active.current = session;
      setAttached(id);
      setAwaitingFrame(request.run);
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
                if (first) setAwaitingFrame(null);
                if (session.reader) session.reader.update(snapshot, ack);
                else session.reader = new LiveSource(snapshot, ack);
                callbacks.current.onFrame(session.reader, first);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (e) {
          if (!session.abort.signal.aborted) {
            setAwaitingFrame(null);
            setError((e as Error).message);
            callbacks.current.onOpen();
          }
        } finally {
          clearInterval(heartbeat);
        }
      };
      void pump();
    } catch (e) {
      if (pendingAttachment.current === request) {
        cancelAttachment();
        setError((e as Error).message);
        callbacks.current.onOpen();
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!awaitingFrame) return;
    const row = runs.find((run) => run.id === awaitingFrame.id);
    if (row && ["failed", "stopped", "completed"].includes(row.status)) {
      void detachActive();
      if (!pendingAttachment.current) {
        setError(
          `${row.name}: ${row.message || "The simulation ended before its first live frame."}`,
        );
        callbacks.current.onOpen();
      }
    }
  }, [runs, awaitingFrame]);
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
  async function launch(spec: object) {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const run = await client.launch(spec);
      if (connectedClient.current !== client) return;
      setRuns((old) => [...old.filter((row) => row.id !== run.id), run]);
      enqueueAttachment(run, "launch");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = !client
    ? "Connect to a daemon"
    : {
        connection: "Daemon connection",
        running: "Running simulations",
        history: "Simulation history",
        launch: "Run a simulation",
      }[section];
  const connectingRun = pending?.run ?? awaitingFrame;
  return (
    <>
      {connectingRun && !open && (
        <div className="companion-notice" role="status">
          <Radio size={16} />
          <span>
            Connecting to <strong>{connectingRun.name}</strong> · waiting for
            startup…
          </span>
          <button onClick={onOpen}>View simulations</button>
          <button
            onClick={() => (pending ? cancelAttachment() : void detach())}
          >
            Cancel connection
          </button>
        </div>
      )}
      {notice && !connectingRun && !open && (
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
      {(open || client) && (
        <div
          className="modal-backdrop"
          hidden={!open}
          style={open ? undefined : { display: "none" }}
          onPointerDown={(e) => {
            backdropPress.current = e.target === e.currentTarget;
          }}
          onPointerUp={(e) => {
            backdropPress.current =
              backdropPress.current && e.target === e.currentTarget;
          }}
          onPointerCancel={() => {
            backdropPress.current = false;
          }}
          onClick={(e) => {
            const outside = backdropPress.current;
            backdropPress.current = false;
            if (
              outside &&
              e.target === e.currentTarget &&
              !(client && section === "launch")
            )
              closePanel();
          }}
        >
          <section
            className="modal companion-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="companion-heading">
              <div>
                <div className="eyebrow">LOCAL COMPANION</div>
                <h2>{title}</h2>
                <p>
                  {!client
                    ? "Pair once, then choose the simulation task you want."
                    : section === "launch"
                      ? "Close this window to leave setup. Your draft is kept while connected to this daemon."
                      : "Your daemon manages the available cases and resident simulations."}
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
                  Updated companions keep the token across restarts. Use
                  warpsph-companion --show-token to retrieve it. The companion
                  listens only on localhost.
                </small>
              </section>
            ) : (
              <>
                {section === "connection" && (
                  <>
                    <div className="companion-connection">
                      <span className="tiny-dot" /> Connected ·{" "}
                      {client.endpoint}
                      <button
                        onClick={async () => {
                          connectedClient.current = null;
                          setClient(null);
                          setRuns([]);
                          await detach();
                          historySession.current?.abort();
                        }}
                      >
                        Disconnect
                      </button>
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            const info = await client.session(undefined, true);
                            setPresets(info.presets);
                            setFeatures(info.features || []);
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Refresh available cases
                      </button>
                      <button onClick={() => void forgetSavedPairing()}>
                        Forget pairing
                      </button>
                      {storageMessage && (
                        <small role="status">{storageMessage}</small>
                      )}
                    </div>
                  </>
                )}
                {section === "running" && (
                  <>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={monitor}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          monitorEnabled.current = enabled;
                          setMonitor(enabled);
                          rememberMonitor(enabled);
                          if (enabled) known.current = null;
                          else if (
                            pendingAttachment.current?.reason === "monitor"
                          )
                            cancelAttachment();
                        }}
                      />
                      Automatically watch new simulations
                    </label>
                    <small>
                      Monitor mode switches this view to the newest active
                      launch, including simulations started outside this page.
                    </small>
                  </>
                )}
                {pending && (
                  <p role="status">
                    Waiting to connect to {pending.run.name}…{" "}
                    <button className="text-button" onClick={cancelAttachment}>
                      Cancel connection
                    </button>
                  </p>
                )}
                {(section === "running" || section === "history") && (
                  <section className="companion-runs">
                    <div className="section-heading">
                      <Activity size={15} />{" "}
                      {section === "history"
                        ? "DAEMON RUN HISTORY"
                        : "ACTIVE SIMULATIONS"}{" "}
                      <small>
                        {
                          runs.filter(
                            (run) =>
                              section === "history" ||
                              ["running", "starting", "paused"].includes(
                                run.status,
                              ),
                          ).length
                        }
                      </small>
                    </div>
                    {section === "history" && (
                      <p>
                        Run metadata for this daemon session. Replay is
                        available only when trajectory recording was enabled.
                      </p>
                    )}
                    {!runs.filter(
                      (run) =>
                        section === "history" ||
                        ["running", "starting", "paused"].includes(run.status),
                    ).length && (
                      <p className="empty-hint">
                        No simulations yet. Use Run simulation, or register a
                        simulation with <code>run_live(case, …)</code>.
                      </p>
                    )}
                    {runs
                      .filter(
                        (run) =>
                          section === "history" ||
                          ["running", "starting", "paused"].includes(
                            run.status,
                          ),
                      )
                      .sort(
                        (a, b) =>
                          Number(
                            ["running", "starting", "paused"].includes(
                              b.status,
                            ),
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
                                  {run.dt == null
                                    ? "—"
                                    : formatNumber(run.dt, 4)}
                                </b>
                              </span>
                            </div>
                            {!run.recording?.enabled && (
                              <small>Trajectory not recorded</small>
                            )}
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
                            {features.includes("pause") &&
                              ["running", "starting", "paused"].includes(
                                run.status,
                              ) && (
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
                )}
                <div hidden={section !== "launch"}>
                  <LaunchWizard
                    client={client}
                    presets={presets}
                    features={features}
                    runs={runs}
                    busy={busy}
                    onLaunch={launch}
                  />
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
