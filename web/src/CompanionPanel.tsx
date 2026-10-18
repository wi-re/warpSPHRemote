import { RunReport } from "./RunReport";
import type { FrameTransfer } from "./liveMetrics";
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
  remoteConnection,
  companionConnectionMessage,
  companionUnavailableMessage,
  companionRequestTimeout,
  CompanionHTTPError,
  viewerConnectionConflict,
  canPauseSimulation,
  liveConnectionStatus,
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
  takeover?: boolean;
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
  prepareVideo: (fps: number) => Promise<void>;
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
  prepareVideo,
}: Props) {
  const backdropPress = useRef(false);
  const [reportRun, setReportRun] = useState<Simulation | null>(null);
  const [offlineMessage, setOfflineMessage] = useState("");
  const offline = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const retryConnection = useRef<(() => void) | null>(null);
  const [monitor, setMonitor] = useState(recallMonitor);
  const monitorEnabled = useRef(monitor);
  monitorEnabled.current = monitor;
  const [takeoverRequest, setTakeoverRequest] =
    useState<PendingAttachment | null>(null);
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [awaitingFrame, setAwaitingFrame] = useState<Simulation | null>(null);
  const pendingAttachment = useRef<PendingAttachment | null>(null);
  const [viewerStage, setViewerStage] = useState("idle");
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
  const [observedAt, setObservedAt] = useState(Date.now);
  const [transfersPaused, setTransfersPaused] = useState(false);
  const [captureInterval, setCaptureInterval] = useState(0.5);
  const intervalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [transfer, setTransfer] = useState<FrameTransfer>();
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
    transfer?: FrameTransfer;
    transfersPaused: boolean;
    captureInterval: number;
    download?: AbortController;
    settingsQueue: Promise<unknown>;
    video: boolean;
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
  useEffect(
    () => onConnection(!!client && !offlineMessage),
    [client, offlineMessage, onConnection],
  );
  useEffect(() => {
    if (open && client && offline.current) retryConnection.current?.();
    else if (open && !client && saved && !connection.current && !error)
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
    offline.current = false;
    setOfflineMessage("");
    setTakeoverRequest(null);
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
        setError(companionConnectionMessage(error, address));
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
  function forgetLiveSession() {
    const session = active.current;
    if (!session) return;
    active.current = null;
    session.abort.abort();
    setAttached("");
    setAwaitingFrame(null);
    callbacks.current.onDetached(`live-${session.id}`);
  }
  function daemonUnavailable(owner: CompanionClient, error: unknown) {
    const message = companionUnavailableMessage(error);
    if (!message || connectedClient.current !== owner) return false;
    offline.current = true;
    setOfflineMessage(message);
    setError("");
    setTakeoverRequest(null);
    cancelAttachment();
    forgetLiveSession();
    historySession.current?.abort();
    setNotice(null);
    setRuns((old) => old.map((run) => ({ ...run, stale: true })));
    return true;
  }
  function reportError(
    error: unknown,
    owner: CompanionClient | null = connectedClient.current,
  ) {
    if (owner && connectedClient.current !== owner) return;
    if (!owner || !daemonUnavailable(owner, error))
      setError(companionConnectionMessage(error));
  }
  function connectionSettings() {
    forgetLiveSession();
    cancelAttachment();
    connectedClient.current = null;
    setClient(null);
    setRuns([]);
    setError("");
    setTakeoverRequest(null);
    offline.current = false;
    setOfflineMessage("");
  }
  async function togglePause(run: Simulation) {
    if (
      !client ||
      offline.current ||
      controlRequest.current ||
      !canPauseSimulation(run, features)
    )
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
      reportError(e, client);
      callbacks.current.onOpen();
    } finally {
      controlRequest.current = "";
      setControlBusy("");
    }
  }
  function sendStreamingSettings(session: NonNullable<typeof active.current>) {
    if (!features.includes("streaming")) return;
    session.settingsQueue = session.settingsQueue
      .catch(() => {})
      .then(async () => {
        if (active.current !== session) return;
        await session.client.streaming(session.id, {
          paused: session.transfersPaused,
          interval: session.captureInterval,
        });
      })
      .catch((error) => {
        if (active.current === session) reportError(error, session.client);
      });
  }
  function toggleTransfers() {
    const session = active.current;
    if (!session) return;
    session.transfersPaused = !session.transfersPaused;
    setTransfersPaused(session.transfersPaused);
    if (session.transfersPaused) session.download?.abort();
    sendStreamingSettings(session);
  }
  function changeCaptureInterval(seconds: number) {
    const session = active.current;
    if (!session || !Number.isFinite(seconds) || seconds < 0) return;
    session.captureInterval = seconds;
    setCaptureInterval(seconds);
    clearTimeout(intervalTimer.current);
    intervalTimer.current = setTimeout(
      () => sendStreamingSettings(session),
      200,
    );
  }
  useEffect(() => {
    const run = runs.find((row) => row.id === attached);
    callbacks.current.onControl(
      run && client
        ? {
            sourceId: `live-${run.id}`,
            setVideo:
              features.includes("synchronizedVideo") && run.videoSupported
                ? async (enabled, interval, adopt, everySteps) => {
                    const session = active.current;
                    if (!session || session.id !== run.id)
                      throw new Error("Reconnect the simulation first.");
                    session.video = enabled;
                    session.transfersPaused = false;
                    setTransfersPaused(false);
                    await session.settingsQueue;
                    try {
                      await client.videoCapture(
                        run.id,
                        enabled,
                        interval,
                        adopt,
                        everySteps,
                      );
                    } catch (error) {
                      session.video = false;
                      throw error;
                    }
                  }
                : undefined,
            run,
            canStepVideo:
              features.includes("stepVideo") &&
              !!run.capabilities?.includes("stepVideo"),
            viewerStage,
            observedAt,
            transfer,
            transfersPaused,
            toggleTransfers,
            captureInterval,
            canSetCaptureInterval: features.includes("streaming"),
            setCaptureInterval: changeCaptureInterval,
            configurationAvailable: run.configurationAvailable,
            inspectConfiguration: () => client.configurationOfRun(run.id),
            setDiagnosticProbes: run.measurements
              ? (probes) => client.diagnosticProbes(run.id, probes)
              : undefined,
            status: run.status,
            pauseRequested: !!run.pauseRequested,
            canPause: canPauseSimulation(run, features),
            busy: !!controlBusy,
            toggle: () => void togglePause(run),
          }
        : null,
    );
  }, [
    viewerStage,
    runs,
    attached,
    client,
    features,
    controlBusy,
    transfer,
    observedAt,
    transfersPaused,
    captureInterval,
  ]);
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
    if (!client || offline.current || connectedClient.current !== client)
      return;
    setTakeoverRequest(null);
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
      reportError(e, previous.client);
    }
  }
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    async function poll() {
      if (polling || stopped) return;
      clearTimeout(timer);
      polling = true;
      if (offline.current) setReconnecting(true);
      try {
        if (offline.current) {
          const info = await client!.session(
            abort.signal,
            false,
            companionRequestTimeout,
          );
          if (stopped || connectedClient.current !== client) return;
          setPresets(info.presets);
          setFeatures(info.features || []);
        }
        const list = await client!.runs(abort.signal);
        if (stopped || connectedClient.current !== client) return;
        if (offline.current) {
          known.current = null;
          setError("");
        }
        offline.current = false;
        setOfflineMessage("");
        if (
          active.current &&
          !list.some((run) => run.id === active.current!.id)
        ) {
          forgetLiveSession();
          setError(
            "This simulation is no longer registered with the daemon. Surviving simulations using an updated adapter will reappear automatically.",
          );
        }
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
        setObservedAt(Date.now());
        setRuns(list);
      } catch (e) {
        if (!stopped && !daemonUnavailable(client!, e))
          setError(companionConnectionMessage(e));
      } finally {
        polling = false;
        if (!stopped) {
          setReconnecting(false);
          timer = setTimeout(poll, offline.current ? 3000 : 1000);
        }
      }
    }
    retryConnection.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      clearTimeout(intervalTimer.current);
      retryConnection.current = null;
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
    if (offline.current) return;
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
      await client.attach(id, request.takeover);
      if (pendingAttachment.current !== request) {
        await client.detach(id).catch(() => {});
        return;
      }
      cancelAttachment();
      const session: NonNullable<typeof active.current> = {
        id,
        client,
        abort: new AbortController(),
        reader: undefined as LiveSource | undefined,
        waiting: false,
        transfersPaused: false,
        captureInterval: 0.5,
        settingsQueue: Promise.resolve(),
        video: !!request.run.video?.active,
      };
      active.current = session;
      setAttached(id);
      setAwaitingFrame(request.run);
      setNotice(null);
      onClose();
      setTransfer(undefined);
      setTransfersPaused(false);
      setCaptureInterval(0.5);
      setTakeoverRequest(null);
      function connectionLost(error: unknown) {
        if (daemonUnavailable(client, error)) return true;
        if (
          !(error instanceof CompanionHTTPError) ||
          ![400, 404, 409].includes(error.status)
        )
          return false;
        if (active.current === session) {
          active.current = null;
          session.abort.abort();
          clearInterval(heartbeat);
          setAttached("");
          setAwaitingFrame(null);
          callbacks.current.onDetached(`live-${id}`);
          setError(
            "This live connection is no longer owned by this viewer. Another viewer may have taken over. The simulation is unaffected; choose Watch live to reconnect.",
          );
          callbacks.current.onOpen();
        }
        return true;
      }
      // Lease renewal carries no particle data, even while a costly grid is being rendered.
      const heartbeat = setInterval(() => {
        void client
          .request(`/v1/runs/${id}/attach`, {}, session.abort.signal)
          .catch((e) => {
            if (!session.abort.signal.aborted && !connectionLost(e))
              reportError(e, client);
          });
      }, 5000);
      const pump = async () => {
        try {
          while (!session.abort.signal.aborted) {
            if (!session.waiting && !session.transfersPaused) {
              const download = new AbortController();
              session.download = download;
              let snapshot;
              try {
                setViewerStage("downloading");
                snapshot = await client.snapshot(
                  id,
                  AbortSignal.any([session.abort.signal, download.signal]),
                );
              } catch (error) {
                if (download.signal.aborted && !session.abort.signal.aborted)
                  continue;
                throw error;
              } finally {
                session.download = undefined;
              }
              if (session.transfersPaused) {
                setViewerStage("transfers_paused");
                continue;
              }
              setViewerStage(snapshot ? "rendering" : "waiting_snapshot");
              if (snapshot) {
                if (snapshot.transfer) {
                  const previous = session.transfer;
                  session.transfer = {
                    ...snapshot.transfer,
                    intervalMs: previous
                      ? snapshot.transfer.receivedAt - previous.receivedAt
                      : undefined,
                    totalBytes:
                      (previous?.totalBytes ?? 0) + snapshot.transfer.bytes,
                  };
                  setTransfer(session.transfer);
                }
                session.waiting = true;
                const ack = async () => {
                  if (active.current !== session) return;
                  try {
                    await client.ack(id, snapshot.sequence);
                  } catch (error) {
                    if (!connectionLost(error)) throw error;
                  }
                  session.waiting = false;
                  setViewerStage("waiting_snapshot");
                };
                if (
                  !session.video &&
                  session.reader?.sameState(snapshot) &&
                  !!session.reader.metadata.videoArmed ===
                    !!snapshot.metadata.videoArmed
                ) {
                  await ack();
                } else {
                  const first = !session.reader;
                  if (first) setAwaitingFrame(null);
                  if (session.reader) session.reader.update(snapshot, ack);
                  else session.reader = new LiveSource(snapshot, ack);
                  callbacks.current.onFrame(session.reader, first);
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (e) {
          if (!session.abort.signal.aborted && !connectionLost(e)) {
            setAwaitingFrame(null);
            reportError(e, client);
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
        if (daemonUnavailable(client, e)) return;
        if (viewerConnectionConflict(e)) {
          setTakeoverRequest(request);
          setError(
            features.includes("viewerTakeover")
              ? "Another viewer holds the live connection. You can take it over here; its live updates will stop, and the simulation will keep running."
              : "Another viewer holds the live connection. Restart the updated companion to enable Take over connection, or close the other viewer and retry.",
          );
        } else reportError(e, client);
        callbacks.current.onOpen();
      }
    } finally {
      setBusy(false);
    }
  }
  function takeOverConnection() {
    if (
      !takeoverRequest ||
      takeoverRequest.client !== client ||
      !features.includes("viewerTakeover")
    )
      return;
    const request = {
      ...takeoverRequest,
      reason: "manual" as const,
      takeover: true,
    };
    setTakeoverRequest(null);
    setError("");
    pendingAttachment.current = request;
    setPending(request);
    callbacks.current.onClose();
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
  async function viewHistory(id: string, time?: number) {
    if (!client || offline.current) return;
    setBusy(true);
    setError("");
    historySession.current?.abort();
    const abort = new AbortController();
    historySession.current = abort;
    await detach();
    try {
      const metadata = await client.recording(id, abort.signal);
      if (time !== undefined)
        metadata.initialFrame = metadata.times.reduce(
          (best, t, i) =>
            Math.abs(t - time) < Math.abs(metadata.times[best] - time)
              ? i
              : best,
          0,
        );
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
          if (!abort.signal.aborted) reportError(e, client);
        }
        if (!abort.signal.aborted) setTimeout(refresh, 2000);
      };
      setTimeout(refresh, 2000);
    } catch (e) {
      if (!abort.signal.aborted) reportError(e, client);
    } finally {
      setBusy(false);
    }
  }
  async function launch(spec: object) {
    if (!client || offline.current) return;
    setBusy(true);
    setError("");
    try {
      const video = (spec as { video?: { fps: number } }).video;
      if (video) await prepareVideo(video.fps);
      const run = await client.launch(spec);
      if (connectedClient.current !== client) return;
      setRuns((old) => [...old.filter((row) => row.id !== run.id), run]);
      enqueueAttachment(run, "launch");
    } catch (e) {
      reportError(e, client);
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
  const connectingTarget = pending?.run ?? awaitingFrame;
  const connectingRun = connectingTarget
    ? (runs.find((run) => run.id === connectingTarget.id) ?? connectingTarget)
    : null;
  return (
    <>
      {connectingRun && !open && (
        <div className="companion-notice" role="status">
          <Radio size={16} />
          <span>
            Connecting to <strong>{connectingRun.name}</strong> ·{" "}
            {liveConnectionStatus(connectingRun)}
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
            {client && offlineMessage && (
              <div className="companion-offline" role="status">
                <strong>Daemon unavailable</strong>
                <p>
                  {offlineMessage} Pairing is retained. The last displayed frame
                  remains available.
                </p>
                <button
                  className="secondary-button"
                  disabled={reconnecting}
                  onClick={() => retryConnection.current?.()}
                >
                  {reconnecting ? "Reconnecting…" : "Reconnect now"}
                </button>
                <button className="text-button" onClick={connectionSettings}>
                  Connection settings
                </button>
              </div>
            )}
            {error && (
              <div className="companion-error" role="alert">
                <div>
                  <span>{error}</span>
                  {takeoverRequest?.client === client &&
                    features.includes("viewerTakeover") && (
                      <button
                        className="secondary-button"
                        disabled={!!offlineMessage || busy}
                        onClick={takeOverConnection}
                      >
                        Take over connection
                      </button>
                    )}
                </div>
                <button
                  onClick={() => {
                    setError("");
                    setTakeoverRequest(null);
                  }}
                  aria-label="Dismiss companion error"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!client ? (
              <section className="companion-connect">
                <label className="connection-mode">
                  Connection
                  <select
                    aria-label="Connection type"
                    value={remoteConnection(endpoint) ? "remote" : "local"}
                    disabled={busy || !!offlineMessage}
                    onChange={(event) => {
                      setToken("");
                      setEndpoint(
                        event.target.value === "remote"
                          ? "https://"
                          : "http://127.0.0.1:8766",
                      );
                    }}
                  >
                    <option value="local">This device / SSH tunnel</option>
                    <option value="remote">Remote host · HTTPS</option>
                  </select>
                </label>
                <h3>
                  {remoteConnection(endpoint)
                    ? "Connect to a remote host"
                    : "Connect to this device"}
                </h3>
                {remoteConnection(endpoint) ? (
                  <>
                    <p>
                      Start HTTPS remote mode explicitly on the simulation host.
                      Use its IP or DNS name and the remote pairing token
                      printed there.
                    </p>
                    <pre>
                      warpsph-companion --remote-host 192.168.1.20 --tls-cert
                      /path/to/cert.pem --tls-key /path/to/key.pem
                    </pre>
                    <small>
                      The certificate must be trusted by this browser and match
                      the address. Remote tokens change when the daemon
                      restarts. A VPN supplies connectivity; HTTPS protects the
                      connection.
                    </small>
                    <p>
                      <a
                        href="https://github.com/wi-re/warpSPHRemote/blob/main/reports/REMOTE_CONNECTIONS.md"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Remote setup and certificate instructions
                      </a>
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Start the companion in your warpSPH environment. Copy the
                      local pairing token printed in the terminal.
                    </p>
                    <pre>
                      warpsph-companion --python /path/to/warp/bin/python
                    </pre>
                  </>
                )}
                <div className="companion-form">
                  <label>
                    Address
                    <input
                      value={endpoint}
                      placeholder={
                        remoteConnection(endpoint)
                          ? "https://192.168.1.20:8767"
                          : "http://127.0.0.1:8766"
                      }
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
                      disabled={!!offlineMessage || busy}
                    />
                  </label>
                  <label>
                    {remoteConnection(endpoint)
                      ? "Remote pairing token"
                      : "Pairing token"}
                    <input
                      type="password"
                      disabled={!!offlineMessage || busy}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={!!offlineMessage || busy || !token}
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
                    disabled={!!offlineMessage || busy}
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
                  <summary>Connect through SSH instead</summary>
                  <p>
                    On this device, forward the simulation host's loopback
                    daemon:
                  </p>
                  <pre>ssh -N -L 8766:127.0.0.1:8766 user@simulation-host</pre>
                  <p>
                    Choose This device / SSH tunnel and connect to
                    http://127.0.0.1:8766 using the host's local pairing token.
                    No remote listener or certificate is needed.
                  </p>
                </details>
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
                  warpsph-companion --show-token to retrieve the persistent
                  local token, or --show-remote-token for an active HTTPS
                  listener. Remote listening always requires explicit CLI
                  startup.
                </small>
              </section>
            ) : (
              <>
                {section === "connection" && (
                  <>
                    <div className="companion-connection">
                      <span className="tiny-dot" /> Connected ·{" "}
                      {client.endpoint} ·{" "}
                      {remoteConnection(client.endpoint)
                        ? "HTTPS remote connection"
                        : "Local / SSH connection"}
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
                        disabled={!!offlineMessage || busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            const info = await client.session(undefined, true);
                            setPresets(info.presets);
                            setFeatures(info.features || []);
                          } catch (e) {
                            reportError(e, client);
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
                {reportRun && (
                  <RunReport
                    key={reportRun.id}
                    client={client}
                    run={reportRun}
                    onTime={
                      reportRun.recording?.enabled
                        ? (t) => void viewHistory(reportRun.id, t)
                        : undefined
                    }
                    onClose={() => setReportRun(null)}
                  />
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
                        Persistent run metadata and optional diagnostic
                        histories. Replay is available only when trajectory
                        recording was enabled.
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
                            {(run.libraryError || run.libraryWarning) && (
                              <small className="inline-error">
                                {run.libraryError || run.libraryWarning}
                              </small>
                            )}
                            {run.message && (
                              <small className="inline-error">
                                {run.message}
                              </small>
                            )}
                          </div>
                          <div className="run-actions">
                            <button
                              className="secondary-button"
                              disabled={!features.includes("runLibrary")}
                              onClick={() => setReportRun(run)}
                            >
                              Run report
                            </button>
                            {[
                              "completed",
                              "stopped",
                              "failed",
                              "interrupted",
                            ].includes(run.status) && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "Forget this run entry and diagnostic history? Particle exports and logs remain on disk.",
                                    )
                                  )
                                    void client
                                      .forgetRun(run.id)
                                      .then(() => {
                                        setRuns((old) =>
                                          old.filter((r) => r.id !== run.id),
                                        );
                                        if (reportRun?.id === run.id)
                                          setReportRun(null);
                                      })
                                      .catch((e) => reportError(e, client));
                                }}
                              >
                                Forget entry
                              </button>
                            )}
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
                                  !!offlineMessage ||
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
                                disabled={!!offlineMessage || busy}
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
                                    !!offlineMessage ||
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
                                !!offlineMessage ||
                                !["running", "starting", "paused"].includes(
                                  run.status,
                                )
                              }
                              onClick={() => {
                                void client
                                  .stop(run.id)
                                  .catch((e) => reportError(e, client));
                              }}
                            >
                              <Square size={12} /> Stop
                            </button>
                          </div>
                        </article>
                      ))}
                    <small>
                      Without an attached viewer, simulations send status and
                      any enabled diagnostic recording. Finished run reports
                      persist across daemon restarts. Live diagnostics sample
                      displayed snapshots (last 600); Recording is optional.
                      View history reads exported frames while the simulation
                      runs or is paused; Watch live returns to current
                      snapshots.
                    </small>
                  </section>
                )}
                <div hidden={section !== "launch"}>
                  <LaunchWizard
                    client={client}
                    presets={presets}
                    features={features}
                    runs={runs}
                    busy={!!offlineMessage || busy}
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
