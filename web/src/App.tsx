import {
  saveRecordingView,
  readRecordingView,
  videoPlan,
  videoPlanText,
  validCadence,
  type RecordingView,
  type ViewportSettings,
} from "./recording";
import { ProfileRenderer } from "./ProfileRenderer";
import {
  ViewportVideo,
  videoDimensions,
  captureViewport,
  saveVideo,
} from "./video";
import { LiveMetrics } from "./LiveMetrics";
import { ProfilePlots } from "./ProfilePlots";
import { CompanionPanel, type CompanionSection } from "./CompanionPanel";
import { LiveSource, type SimulationControl } from "./companion";
import { reduceDiagnostic } from "./sources/core";
import { NumberControl } from "./NumberControl";
import { defaultAnalysis, type AnalysisPreferences } from "./sources/analysis";
import { QuantityAnalysis } from "./QuantityAnalysis";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { metricDefinitions, defaultMetrics } from "./metrics";
import {
  colorPresets,
  sourcePreset,
  parseViewLink,
  buildViewURL,
} from "./viewPresets";
import { FTLEMap } from "./FTLEMap";
import {
  useMaterialMotion,
  MaterialCapture,
  MaterialTools,
  MaterialChart,
} from "./MaterialMotion";
import { selectionIndex, type ParticleSelection } from "./sources/selection";
import {
  TrajectoryPicker,
  type PickerTab,
  type SavedRecordingInfo,
} from "./TrajectoryPicker";
import { readPreferences, savePreferences } from "./preferences";
import {
  categoricalField,
  derivativeQuantity,
  gridQuantityLabel,
} from "./sources/grid";
import { useFieldView, FieldControls } from "./FieldView";
import {
  recordedDemos,
  loadDemoFile,
  demoSize,
  type RecordedDemo,
  type DemoStage,
} from "./recordedDemos";
import { loadPresentation, type Presentation } from "./sources/presentation";
import {
  rememberFiles,
  recallFiles,
  forgetFiles,
  rememberEnabled,
  setRememberEnabled,
  fileKey,
  recallView,
  saveView,
  cacheDemo,
  recallDemo,
} from "./session";
import type { DiagnosticMetric } from "./types";
import { useParticleTrace, TraceControls } from "./ParticleTrace";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  FolderOpen,
  Grid2X2,
  Info,
  Layers,
  LoaderCircle,
  Maximize,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Repeat2,
  Rotate3D,
  Settings2,
  SlidersHorizontal,
  Target,
  X,
} from "lucide-react";
import { ParticleRenderer } from "./renderer";
import { fieldLabel, formatNumber, request } from "./data";
import {
  BrowserSource,
  ServiceSource,
  type TrajectorySource,
} from "./sources/client";
import { gradient, palettes } from "./palettes";
import { usePressureProbes, PressureControls } from "./PressureProbes";
import { DiagnosticChart, PressureChart } from "./Chart";
import { initialOptions } from "./types";
import type { Diagnostic, Source, ViewOptions, Frame } from "./types";

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`toggle ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span />
    </button>
  );
}
function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
const mergeRows = (old: Diagnostic[], next: Diagnostic[]) =>
  [...new Map([...old, ...next].map((r) => [r.index, r])).values()].sort(
    (a, b) => a.index - b.index,
  );
const friendlyName = (source: Source) =>
  source.name
    .replace(/-pyvista$|-vispy$/, "")
    .replace("marrone31", "Marrone · wall impact")
    .replace(/^tgv$/, "Taylor–Green vortex")
    .replace(/^khh$/, "Kelvin–Helmholtz")
    .replace(/^sod$/, "Sod shock tube");

export default function App() {
  const [liveControl, setLiveControl] = useState<SimulationControl | null>(
    null,
  );
  const [companionOpen, setCompanionOpen] = useState(false);
  const [companionSection, setCompanionSection] =
    useState<CompanionSection>("running");
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [recordingView, setRecordingView] = useState<RecordingView | null>(
    null,
  );
  const pendingViewport = useRef<ViewportSettings | null>(null);
  const [videoMode, setVideoMode] = useState<"time" | "steps">("time");
  const [videoEverySteps, setVideoEverySteps] = useState(10);
  const [videoEncoding, setVideoEncoding] = useState(false);
  const [videoEncodeMs, setVideoEncodeMs] = useState<number>();
  const [prepareMs, setPrepareMs] = useState<number>();
  const prepareStarted = useRef<number | undefined>(undefined);
  const preparedVideo = useRef("");
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoFPS, setVideoFPS] = useState(30),
    [videoInterval, setVideoInterval] = useState(0.04);
  const [videoStart, setVideoStart] = useState(0),
    [videoEnd, setVideoEnd] = useState(0),
    [videoStride, setVideoStride] = useState(1);
  const [videoProgress, setVideoProgress] = useState(""),
    [videoError, setVideoError] = useState("");
  const videoSession = useRef<{
    encoder: ViewportVideo;
    sourceId: string;
    name: string;
    live: boolean;
    end: number;
    stride: number;
    seen: Set<string>;
    lastFrame?: Frame;
    pending: Promise<void>;
    stopping: boolean;
    release?: () => Promise<void>;
  } | null>(null);

  const [configurationView, setConfigurationView] = useState<{
    loading: boolean;
    data?: unknown;
    error?: string;
  } | null>(null);
  const [sources, setSources] = useState<Source[]>([]),
    [sourceId, setSourceId] = useState("");
  const source = sources.find((s) => s.id === sourceId);
  const simulationControl =
    source?.live && liveControl?.sourceId === source.id ? liveControl : null;
  useEffect(() => {
    setRecordingView(sourceId ? readRecordingView(sourceId) : null);
  }, [sourceId]);
  const [reconstructionWarning, setReconstructionWarning] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const [presentation, setPresentation] = useState<Presentation | null>(null),
    [index, setIndex] = useState(0),
    [field, setField] = useState("velocities");
  const frame = presentation?.sourceId === sourceId ? presentation.frame : null;
  const [options, setOptions] = useState<ViewOptions>(() => ({
      ...initialOptions,
      background: readPreferences().theme,
      wrapPeriodic: readPreferences().wrapPeriodic,
    })),
    [range, setRange] = useState<[number, number]>([0, 1]),
    [validRange, setValidRange] = useState(true);
  const [displayedOptions, setDisplayedOptions] = useState(options);
  const [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(true),
    [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [engineError, setEngineError] = useState("");
  useEffect(() => {
    if (loading) prepareStarted.current = performance.now();
    else if (prepareStarted.current !== undefined) {
      setPrepareMs(performance.now() - prepareStarted.current);
      prepareStarted.current = undefined;
    }
  }, [loading]);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [theme, setTheme] = useState(() => readPreferences().theme),
    [pickerTab, setPickerTab] = useState<PickerTab>("examples"),
    [savedInfo, setSavedInfo] = useState<SavedRecordingInfo | null>(null);
  const [open, setOpen] = useState(false),
    [path, setPath] = useState(""),
    [opening, setOpening] = useState(false),
    [openError, setOpenError] = useState("");
  const [dragging, setDragging] = useState(false);
  const serviceMode =
    new URLSearchParams(window.location.search).get("service") === "1";
  const registry = useRef(new Map<string, TrajectorySource>());
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  const openingRef = useRef(false);
  const [remember, setRemember] = useState(rememberEnabled),
    [storageStatus, setStorageStatus] = useState("");
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  const localFiles = useRef(new Map<string, File[]>()),
    interactions = useRef(0),
    saveSequence = useRef(0);
  const [activeFileKey, setActiveFileKey] = useState("");
  const demoAbort = useRef<AbortController | null>(null);
  const [demoDownload, setDemoDownload] = useState<{
    id: string;
    received: number;
    stage: DemoStage;
  } | null>(null);
  const [demoError, setDemoError] = useState("");
  const [cachedDemos, setCachedDemos] = useState<Set<string>>(() => new Set());
  const [demoCacheError, setDemoCacheError] = useState("");
  const markDemoCached = (id: string) =>
    setCachedDemos((old) => new Set([...old, id]));
  const cancelDemo = () => {
    demoAbort.current?.abort();
    demoAbort.current = null;
    setDemoDownload(null);
  };
  const persistFiles = (files: File[]) => {
    if (!rememberRef.current) return;
    const sequence = ++saveSequence.current;
    setStorageStatus("Saving local copy…");
    rememberFiles(files)
      .then(() => {
        if (sequence === saveSequence.current)
          setStorageStatus("Saved for refresh");
      })
      .catch((e) => {
        if (sequence === saveSequence.current)
          setStorageStatus(
            `Could not retain recording: ${e.message}. The open file is still usable.`,
          );
      });
  };
  const forgetRecording = async () => {
    interactions.current++;
    ++saveSequence.current;
    try {
      await forgetFiles();
      setStorageStatus("Remembered recording removed");
      setSavedInfo(null);
    } catch (e) {
      setStorageStatus(e instanceof Error ? e.message : String(e));
    }
  };
  const [rows, setRows] = useState<Diagnostic[]>([]),
    [diagnosticError, setDiagnosticError] = useState(""),
    [metric, setMetric] = useState<DiagnosticMetric | "pressure" | "material">(
      "kineticEnergy",
    );
  const [activeMetrics, setActiveMetrics] = useState<DiagnosticMetric[]>(
    defaultMetrics(false),
  );
  const viewLink = useRef(parseViewLink(location.search));
  const [quantityAnalysis, setQuantityAnalysis] = useState<
    "histogram" | "spectrum" | null
  >(null);
  const [analysisPreferences, setAnalysisPreferences] =
    useState<AnalysisPreferences>(viewLink.current.analysis ?? defaultAnalysis);
  const [shareLink, setShareLink] = useState("");
  const [ftleOpen, setFTLEOpen] = useState(false);
  const [traceUid, setTraceUid] = useState("");
  const [selection, setSelection] = useState<ParticleSelection | null>(null),
    [picking, setPicking] = useState(false),
    [chartsExpanded, setChartsExpanded] = useState(true),
    [renderMs, setRenderMs] = useState(0),
    [fetchMs, setFetchMs] = useState(0),
    [inspector, setInspector] = useState(true),
    [help, setHelp] = useState(false);
  const [profileFollow, setProfileFollow] = useState(true);
  const [axes, setAxes] = useState([
    [1, 0],
    [0, 1],
    [0, 0],
  ]);
  const materialPick = useRef<
    (uid: string, index: number, sourceId: string) => void
  >(() => {});
  const host = useRef<HTMLDivElement>(null),
    engine = useRef<ParticleRenderer | ProfileRenderer | null>(null),
    initialFocus = useRef<HTMLInputElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const setOption = <K extends keyof ViewOptions>(
    key: K,
    value: ViewOptions[K],
  ) => setOptions((o) => ({ ...o, [key]: value }));
  const selected = useMemo(
    () => selectionIndex(selection, sourceId, frame),
    [selection, sourceId, frame],
  );
  const clearSelection = () => {
    setSelection(null);
    setTraceUid("");
    engine.current?.select(-1);
  };
  const selectedPosition =
    selected >= 0 && frame
      ? Array.from({ length: source?.dimension ?? 2 }, (_, c) =>
          Number(
            frame.arrays.positions.data[
              selected * (source?.dimension ?? 2) + c
            ],
          ),
        )
      : [];
  const fieldView = useFieldView(source, selectedPosition);
  const categoricalMapping =
    categoricalField(field) && !derivativeQuantity(fieldView.settings.quantity);
  const requestedFieldQuery = fieldView.query(
    index,
    field,
    options.mapping,
    options.wrapPeriodic,
  );
  const fieldQuery =
    categoricalMapping && requestedFieldQuery
      ? fieldView.flow
        ? {
            ...requestedFieldQuery,
            field: "velocities",
            mapping: "magnitude" as const,
            lic: undefined,
          }
        : null
      : requestedFieldQuery;
  const displayMode =
    source?.dimension === 2 && !categoricalMapping
      ? fieldView.mode
      : "particles";
  const presentationKey = JSON.stringify([
    sourceId,
    source?.liveRevision,
    index,
    field,
    displayMode,
    fieldQuery,
  ]);
  useEffect(
    () =>
      savePreferences({
        theme,
        backend: fieldView.settings.backend ?? "auto",
        wrapPeriodic: options.wrapPeriodic,
      }),
    [theme, fieldView.settings.backend, options.wrapPeriodic],
  );
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    recallFiles()
      .then((saved) => {
        if (!cancelled)
          setSavedInfo(
            saved
              ? {
                  name: saved.files.map((f) => f.name).join(", "),
                  bytes: saved.files.reduce((sum, f) => sum + f.size, 0),
                  key: saved.key,
                }
              : null,
          );
      })
      .catch(() => {
        if (!cancelled) setSavedInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, storageStatus]);
  const showPicker = () => {
    setSettingsOpen(false);
    setHelp(false);
    setOpen(true);
  };
  const showSettings = () => {
    setOpen(false);
    setHelp(false);
    setSettingsOpen(true);
  };
  const frameStarted = useRef(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const chooseSource = (s: Source, automatic = false) => {
    if (!automatic) interactions.current++;
    cancelDemo();
    setDemoError("");
    const files = localFiles.current.get(s.id);
    setActiveFileKey(files ? fileKey(files) : "");
    if (!rememberRef.current || !files) setStorageStatus("");
    if (files && !automatic) persistFiles(files);
    setPlaying(false);
    setSourceId(s.id);
    setIndex(0);
    setPresentation(null);
    setSelection(null);
    setTraceUid("");
    setError("");
    setRows([]);
    if (s.live) setMetric("kineticEnergy");
    setField(
      s.fields.find((f) => f.name === "velocities")?.name ??
        s.fields[0]?.name ??
        "kinds",
    );
    const preset = sourcePreset(s),
      link = viewLink.current;
    preset.view.settings.backend = fieldView.settings.backend;
    setIndex(preset.index);
    setField(preset.field);
    setActiveMetrics(preset.metrics);
    setAnalysisPreferences(defaultAnalysis);
    setOptions((old) => ({ ...old, ...preset.options }));
    fieldView.restore(preset.view, s.id);
    const view =
      rememberRef.current && files ? recallView(fileKey(files)) : null;
    if (view) {
      if (Number.isInteger(view.index))
        setIndex(Math.max(0, Math.min(s.frames - 1, view.index)));
      if (s.fields.some((f) => f.name === view.field)) setField(view.field);
      if (view.options) {
        // A 2D recording cannot use the saved Z component/clip plane.
        setOptions({
          ...view.options,
          mapping:
            s.dimension === 2 && view.options.mapping === "z"
              ? "magnitude"
              : view.options.mapping,
          clipAxis:
            view.options.clipAxis >= s.dimension ? -1 : view.options.clipAxis,
        });
      }
      if (view.metrics) setActiveMetrics(view.metrics);
      if (view.analysis) setAnalysisPreferences(view.analysis);
      if (view.fieldView) fieldView.restore(view.fieldView, s.id);
      if (view.playback) {
        setSpeed(view.playback.speed);
        setLoop(view.playback.loop);
      }
      setQuantityAnalysis(
        view.quantityAnalysis ??
          (view.metric === "histogram" || view.metric === "spectrum"
            ? view.metric
            : null),
      );
      if (
        view.metric &&
        view.metric !== "histogram" &&
        view.metric !== "spectrum"
      )
        setMetric(view.metric);
    }

    if (!link.demo || link.demo === s.id) {
      const requested = link.preset
        ? sourcePreset(s, link.preset)
        : { ...preset, view: view?.fieldView ?? preset.view };
      if (link.preset) {
        setField(requested.field);
        setIndex(requested.index);
        setOptions((old) => ({ ...old, ...requested.options }));
      }
      if (link.field && s.fields.some((f) => f.name === link.field))
        setField(link.field);
      if (link.frame != null) setIndex(Math.min(s.frames - 1, link.frame));
      else if (link.time != null)
        setIndex(
          s.times.reduce(
            (best, t, i) =>
              Math.abs(t - link.time!) < Math.abs(s.times[best] - link.time!)
                ? i
                : best,
            0,
          ),
        );
      setOptions((old) => ({
        ...old,
        ...link.options,
        mapping:
          s.dimension === 2 && link.options.mapping === "z"
            ? "magnitude"
            : (link.options.mapping ?? old.mapping),
      }));
      const merged = {
        ...requested.view,
        ...link.view,
        settings: { ...requested.view.settings, ...link.view.settings },
      };
      fieldView.restore(merged, s.id);
      if (link.chart) {
        if (link.chart === "histogram" || link.chart === "spectrum")
          setQuantityAnalysis(link.chart);
        else setMetric(link.chart as typeof metric);
        if (Object.hasOwn(metricDefinitions, link.chart))
          setActiveMetrics((old) =>
            old.includes(link.chart as DiagnosticMetric)
              ? old
              : [...old, link.chart as DiagnosticMetric],
          );
      }
      if (link.analysisView)
        setQuantityAnalysis(
          link.analysisView === "off" ? null : link.analysisView,
        );
      if (link.analysis) setAnalysisPreferences(link.analysis);
      if (link.metrics) setActiveMetrics(link.metrics);
      if (link.theme) {
        setTheme(link.theme);
        setOptions((old) => ({ ...old, background: link.theme! }));
      }
    }
    if (s.initialFrame !== undefined) setIndex(s.initialFrame);
  };
  useEffect(() => {
    let disposed = false;
    Promise.all(
      recordedDemos.map(async (demo) =>
        (await recallDemo(demo)) ? demo.id : null,
      ),
    )
      .then((ids) => {
        if (!disposed)
          setCachedDemos(
            (old) =>
              new Set([
                ...old,
                ...ids.filter((id): id is string => id !== null),
              ]),
          );
      })
      .catch(() => {
        if (!disposed)
          setDemoCacheError(
            "Browser storage is unavailable; demo downloads may not survive refresh.",
          );
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    const add = (reader: TrajectorySource) => {
      if (disposed) {
        reader.close();
        return;
      }
      registry.current.set(reader.metadata.id, reader);
      setSources((old) => [...old, reader.metadata]);
    };
    const load = async () => {
      if (serviceMode) {
        const list = await request<Source[]>("/api/sources");
        if (disposed) return;
        for (const meta of list) add(new ServiceSource(meta));
        if (list.length) chooseSource(list[0], true);
      } else {
        for (const dim of [1, 2, 3] as const) {
          const reader = await BrowserSource.open([], dim);
          add(reader);
          if (dim === 2 && !disposed && interactions.current === 0)
            chooseSource(reader.metadata, true);
        }
        if (viewLink.current.demo && !disposed) {
          const demo = recordedDemos.find(
            (d) => d.id === viewLink.current.demo,
          );
          if (demo) {
            await openRecordedDemo(demo);
            return;
          }
          const analytical = registry.current.get(viewLink.current.demo);
          if (analytical) {
            chooseSource(analytical.metadata, true);
            return;
          }
          setError("The URL names an unknown demo.");
        }
        if (rememberRef.current && !disposed && interactions.current === 0) {
          try {
            const saved = await recallFiles();
            if (
              saved &&
              !disposed &&
              interactions.current === 0 &&
              rememberRef.current
            ) {
              setStorageStatus("Restoring last recording…");
              let restoreFiles = saved.files;
              let demo = recordedDemos.find(
                (d) =>
                  saved.files.length === 1 &&
                  saved.files[0].name === d.file &&
                  saved.files[0].size === d.bytes &&
                  saved.files[0].lastModified === 0,
              );
              // Migrate the previous last-file copy, or prefer a current cached
              // version. A stale copy remains openable as an ordinary local file.
              if (demo) {
                try {
                  const cached = await recallDemo(demo);
                  if (cached) restoreFiles = [cached];
                  else await cacheDemo(demo, saved.files[0]);
                  if (!disposed) markDemoCached(demo.id);
                } catch (e) {
                  demo = undefined;
                  if (!disposed)
                    setDemoCacheError(
                      `Could not retain the demo download: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
              }
              const reader = await BrowserSource.open(
                restoreFiles,
                undefined,
                demo?.id,
              );
              if (demo)
                reader.metadata = {
                  ...reader.metadata,
                  name: demo.name,
                  format: "Recorded demo",
                };
              if (
                disposed ||
                interactions.current !== 0 ||
                !rememberRef.current
              ) {
                reader.close();
                return;
              }
              localFiles.current.set(reader.metadata.id, restoreFiles);
              add(reader);
              chooseSource(reader.metadata, true);
              setStorageStatus("Restored local copy");
            }
          } catch (e) {
            if (!disposed)
              setStorageStatus(
                `Could not restore recording: ${e instanceof Error ? e.message : String(e)}. Reopen the original file.`,
              );
          }
        }
      }
    };
    load().catch((e) => {
      if (!disposed) setError(e.message);
    });
    folderInput.current?.setAttribute("webkitdirectory", "");
    return () => {
      disposed = true;
      demoAbort.current?.abort();
      for (const reader of registry.current.values()) reader.close();
      registry.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!host.current) return;
    try {
      const e =
        source?.dimension === 1
          ? new ProfileRenderer(host.current)
          : new ParticleRenderer(host.current);
      engine.current = e;
      setProfileFollow(true);
      if (e instanceof ProfileRenderer)
        e.onFollowChanged = () => setProfileFollow(e.follow);
      e.onPick = (i) => {
        setSelection(
          i >= 0 && e.frame && e.source
            ? {
                sourceId: e.source.id,
                frame: e.frame.index,
                index: i,
                uid: e.frame.arrays.UIDs
                  ? String(e.frame.arrays.UIDs.data[i])
                  : undefined,
              }
            : null,
        );
        setTraceUid(
          i >= 0 && e.frame?.arrays.UIDs
            ? String(e.frame.arrays.UIDs.data[i])
            : "",
        );
        if (i >= 0 && e.frame?.arrays.UIDs && e.source)
          materialPick.current(
            String(e.frame.arrays.UIDs.data[i]),
            e.frame.index,
            e.source.id,
          );
      };
      e.onRender = (ms) => {
        setRenderMs(ms);
        setAxes(e.axes());
      };
      return () => {
        e.dispose();
        engine.current = null;
      };
    } catch (e) {
      setEngineError(
        `The GPU renderer could not start: ${e instanceof Error ? e.message : String(e)}. Enable WebGL2 in your browser.`,
      );
    }
  }, [source?.dimension]);
  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setReconstructionWarning("");
    // Scrubbing coalesces requests; playback requests each complete display frame.
    const timer = setTimeout(
      () => {
        const t = performance.now();
        frameStarted.current = t;
        loadPresentation(
          registry.current.get(source.id)!,
          index,
          field,
          displayMode,
          fieldQuery,
          presentationKey,
          abort.signal,
        )
          .then((next) => {
            if (abort.signal.aborted) return;
            setPresentation(next);
            setReconstructionWarning(next.warning ?? "");
            if (next.warning) setPlaying(false);
            setFetchMs(performance.now() - t);
          })
          .catch((e) => {
            if (!abort.signal.aborted) {
              setError(e.message);
              setPlaying(false);
            }
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false);
          });
      },
      fieldQuery && !playingRef.current ? 60 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [presentationKey, retryRevision]);
  useLayoutEffect(() => {
    if (!presentation || !frame || !source || !engine.current) return;
    try {
      const e = engine.current;
      // Both calls happen before the renderer's next animation frame.
      e.setFrame(frame, source, presentation.field, optionsRef.current);
      e.setFieldView(presentation.result, presentation.mode);
      if (pendingViewport.current) {
        e.restoreViewport(pendingViewport.current);
        pendingViewport.current = null;
      }
      setDisplayedOptions(optionsRef.current);
      setRange([...e.range]);
      setValidRange(e.validRange);
      setEngineError("");
      const reader = registry.current.get(source.id);
      if (videoSession.current?.sourceId === source.id) {
        const session = videoSession.current;
        const key = String(frame.index);
        const captured = source.live
          ? session.lastFrame === frame
          : session.seen.has(key);
        if (!captured && !session.stopping) {
          session.lastFrame = frame;
          if (!source.live) session.seen.add(key);
          const scene = e.captureCanvas();
          const labels = {
            title: friendlyName(source),
            quantity: `${scalarTitle} · ${optionsRef.current.normalization}${optionsRef.current.normalization === "cyclic" && optionsRef.current.colorPeriod > 0 ? ` (period ${optionsRef.current.colorPeriod})` : ""}`,

            details: `t = ${formatNumber(frame.time, 6)}${source.dt !== undefined ? ` · Δt = ${formatNumber(source.dt, 5)}` : ""}${source.scheme ? ` · ${source.scheme}` : ""}${source.kernel ? ` · ${source.kernel}` : ""}${source.integrator ? ` · ${source.integrator}` : ""}${presentation.mode !== "particles" ? ` · Grid kernel ${fieldView.settings.kernel}` : ""}`,
            particles: frame.arrays.positions.shape[0],
            palette: optionsRef.current.palette,
            range: e.range as [number, number],
            axes: e.axes(),
            dimension: source.dimension,
            light: optionsRef.current.background === "light",
          };
          const canvas = captureViewport(
            scene,
            labels,
            session.encoder.width,
            session.encoder.height,
          );
          setVideoEncoding(true);
          const encodeStarted = performance.now();
          session.pending = session.encoder
            .add(canvas)
            .then(async () => {
              setVideoEncodeMs(performance.now() - encodeStarted);
              setVideoEncoding(false);
              if (reader instanceof LiveSource)
                await reader.displayed(frame.liveRevision);
              setVideoProgress(
                `${session.encoder.frames} frames encoded · ${(session.encoder.frames / session.encoder.fps).toFixed(2)} s video${session.live ? " · Live capture waits for rendering" : ""}`,
              );
              if (!session.live && !session.stopping) {
                if (frame.index >= session.end) void finishVideo();
                else
                  setIndex(Math.min(session.end, frame.index + session.stride));
              }
            })
            .catch((error) => {
              // Preserve an unacknowledged live frame on encoder failure. Only
              // explicit Finish/release may let an unrecorded solver advance.
              setVideoEncoding(false);
              setVideoError(
                `${String(error)} · Finish & save video to keep the encoded portion and release capture.`,
              );
            });
        }
      } else if (reader instanceof LiveSource && !source.videoArmed)
        void reader
          .displayed(frame.liveRevision)
          .catch((e) => setEngineError(`Live capture paused: ${e.message}`));
    } catch (e) {
      setEngineError(String(e));
    }
  }, [presentation, sourceId]);
  useLayoutEffect(() => {
    // Keep the old quantity, mapping and legend together while its replacement loads.
    if (engine.current && presentation?.key === presentationKey) {
      engine.current.setOptions(options);
      setDisplayedOptions(options);
      setRange([...engine.current.range]);
      setValidRange(engine.current.validRange);
    }
  }, [options, presentation, presentationKey]);
  useEffect(() => {
    engine.current?.setLICAnimation(fieldView.licAnimated, fieldView.licSpeed);
  }, [fieldView.licAnimated, fieldView.licSpeed]);
  useEffect(() => {
    engine.current?.setPicking(picking);
  }, [picking]);
  useEffect(() => {
    engine.current?.select(selected);
  }, [selected, presentation]);
  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    setRows([]);
    setDiagnosticError("");
    if (source.live) return;
    const load = async () => {
      for (let start = 0; start < source.frames; start += 1) {
        const batch = await registry.current
          .get(source.id)!
          .diagnostics(start, 1, abort.signal);
        if (abort.signal.aborted) return;
        setRows((old) => mergeRows(old, batch));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    load().catch((e) => {
      if (e.name !== "AbortError") setDiagnosticError(e.message);
    });
    return () => abort.abort();
  }, [sourceId]);
  useEffect(() => {
    if (!frame || !source) return;
    if (source.live) {
      const row = reduceDiagnostic(
        frame.arrays,
        frame.liveRevision ?? 0,
        frame.time,
      );
      setRows((old) =>
        old.some((r) => r.index === row.index)
          ? old
          : [...old, row].slice(-600),
      );
      return;
    }
    if (rows.some((r) => r.index === frame.index)) return;
    const abort = new AbortController();
    registry.current
      .get(source.id)!
      .diagnostics(frame.index, 1, abort.signal)
      .then((batch) => {
        if (!abort.signal.aborted) setRows((old) => mergeRows(old, batch));
      })
      .catch((e) => {
        if (e.name !== "AbortError") setDiagnosticError(e.message);
      });
    return () => abort.abort();
  }, [frame, sourceId]);
  useEffect(() => {
    if (
      !playing ||
      !source ||
      !frame ||
      loading ||
      presentation?.key !== presentationKey
    )
      return;
    if (index === source.frames - 1) {
      if (loop) {
        const timer = setTimeout(() => setIndex(0), 100);
        return () => clearTimeout(timer);
      }
      setPlaying(false);
      return;
    }
    const delta =
      source.timeKind === "simulation"
        ? (source.times[index + 1] - source.times[index]) * 1000
        : 100;
    const timer = setTimeout(
      () => setIndex(index + 1),
      Math.max(0, delta / speed - (performance.now() - frameStarted.current)),
    );
    return () => clearTimeout(timer);
  }, [
    playing,
    sourceId,
    frame,
    index,
    loading,
    speed,
    loop,
    presentationKey,
    presentation,
  ]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        videoSession.current &&
        !videoSession.current.live &&
        ["Space", "ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        e.preventDefault();
        return;
      }
      if (
        ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
          (e.target as HTMLElement).tagName,
        ) ||
        open ||
        help ||
        settingsOpen ||
        companionOpen ||
        profilesOpen ||
        videoOpen ||
        ftleOpen
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        if (source?.live) {
          if (source.videoArmed && !videoSession.current)
            void playPreparedVideo();
          else if (simulationControl?.canPause && !simulationControl.busy)
            simulationControl.toggle();
        } else if (source && source.frames > 1 && !error) setPlaying((v) => !v);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => Math.min((source?.frames ?? 1) - 1, i + 1));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => Math.max(0, i - 1));
      }
      if (e.key.toLowerCase() === "f") engine.current?.fit();
      if (e.key.toLowerCase() === "p") setPicking((v) => !v);
      if (e.key === "Escape") {
        setPicking(false);
        clearSelection();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [
    source,
    open,
    help,
    settingsOpen,
    ftleOpen,
    companionOpen,
    profilesOpen,
    simulationControl,
    error,
    videoOpen,
    videoFPS,
    videoInterval,
    videoMode,
    videoEverySteps,
    loading,
    presentation,
    presentationKey,
  ]);
  useEffect(() => {
    if (!open && !help && !settingsOpen) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button,input,select,a[href],[tabindex="0"]',
        ) ?? [],
      ).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.tabIndex >= 0 &&
          el.getClientRects().length > 0,
      );
    focusable()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setHelp(false);
        setSettingsOpen(false);
      }
      if (e.key === "Tab") {
        const elements = focusable(),
          first = elements[0],
          last = elements.at(-1);
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [open, help, settingsOpen]);
  const openSource = async (e: React.FormEvent) => {
    e.preventDefault();
    setOpening(true);
    setOpenError("");
    try {
      const next = await request<Source>("/api/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WarpSPH-Client": "trajectory-viewer",
        },
        body: JSON.stringify({ path }),
      });
      registry.current.set(next.id, new ServiceSource(next));
      setSources((old) => [...old, next]);
      chooseSource(next);
      setOpen(false);
      setPath("");
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };
  const openRecordedDemo = async (demo: RecordedDemo) => {
    interactions.current++;
    cancelDemo();
    setDemoError("");
    setDemoCacheError("");
    const existing = registry.current.get(demo.id);
    if (existing) {
      chooseSource(existing.metadata);
      setOpen(false);
      return;
    }
    const abort = new AbortController();
    demoAbort.current = abort;
    setDemoDownload({ id: demo.id, received: 0, stage: "checking" });
    try {
      const file = await loadDemoFile(demo, abort.signal, {
        stage: (stage, received = 0) => {
          if (!abort.signal.aborted)
            setDemoDownload({ id: demo.id, received, stage });
        },
        cached: () => {
          if (!abort.signal.aborted) markDemoCached(demo.id);
        },
        storageIssue: (message) => {
          if (!abort.signal.aborted) setDemoCacheError(message);
        },
      });
      const reader = await BrowserSource.open([file], undefined, demo.id);
      if (abort.signal.aborted) {
        reader.close();
        return;
      }
      reader.metadata = {
        ...reader.metadata,
        name: demo.name,
        format: "Recorded demo",
      };
      registry.current.set(demo.id, reader);
      localFiles.current.set(demo.id, [file]);
      setSources((old) => [...old, reader.metadata]);
      demoAbort.current = null;
      setDemoDownload(null);
      chooseSource(reader.metadata);
      setOpen(false);
    } catch (e) {
      if (!abort.signal.aborted)
        setDemoError(e instanceof Error ? e.message : String(e));
    } finally {
      if (demoAbort.current === abort) {
        demoAbort.current = null;
        setDemoDownload(null);
      }
    }
  };
  const openFiles = async (files: File[]) => {
    interactions.current++;
    cancelDemo();
    if (openingRef.current) return;
    if (!files.length) return;
    openingRef.current = true;
    setOpening(true);
    setOpenError("");
    setPickerTab("file");
    showPicker();
    try {
      if (
        [...registry.current.keys()].filter((id) => !id.startsWith("demo-"))
          .length >= 4
      )
        throw new Error(
          "Close a trajectory before opening another; at most four local recordings are kept open.",
        );
      const reader = await BrowserSource.open(files);
      registry.current.set(reader.metadata.id, reader);
      localFiles.current.set(reader.metadata.id, files);
      setSources((old) => [...old, reader.metadata]);
      chooseSource(reader.metadata, true);
      persistFiles(files);
      setOpen(false);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
      openingRef.current = false;
    }
  };
  const closeCurrent = () => {
    if (!source) return;
    registry.current.get(source.id)?.close();
    registry.current.delete(source.id);
    if (localFiles.current.has(source.id)) void forgetRecording();
    localFiles.current.delete(source.id);
    const remaining = sources.filter((s) => s.id !== source.id);
    setSources(remaining);
    if (remaining.length) chooseSource(remaining[0]);
    else {
      setSourceId("");
      setPresentation(null);
    }
  };
  useEffect(() => {
    if (remember && activeFileKey)
      saveView({
        key: activeFileKey,
        index,
        field,
        options,
        fieldView: fieldView.preferences,
        playback: { speed, loop },
        metric,
        quantityAnalysis,
        metrics: activeMetrics,
        analysis: analysisPreferences,
      });
  }, [
    remember,
    activeFileKey,
    index,
    field,
    options,
    JSON.stringify(fieldView.preferences),
    speed,
    loop,
    metric,
    quantityAnalysis,
    activeMetrics,
    analysisPreferences,
  ]);
  const currentField = source?.fields.find((f) => f.name === field),
    isVector = (currentField?.components ?? 1) > 1;
  const current = source?.live
    ? rows.at(-1)
    : rows.find((r) => r.index === frame?.index);
  const shownDerivative =
    presentation?.mode !== "particles" &&
    derivativeQuantity(presentation?.result?.grid.quantity);
  const scalarTitle = shownDerivative
    ? gridQuantityLabel(presentation?.result?.grid.quantity)
    : fieldLabel(presentation?.field ?? field) +
      ((source?.fields.find((f) => f.name === presentation?.field)
        ?.components ?? 1) > 1
        ? " · " +
          (displayedOptions.mapping === "magnitude"
            ? "magnitude"
            : displayedOptions.mapping.toUpperCase())
        : "");
  function restoreRecordingPreset() {
    if (!recordingView || !source || recordingView.sourceId !== source.id)
      return;
    setField(recordingView.field);
    setOptions(structuredClone(recordingView.options));
    setTheme(recordingView.options.background);
    fieldView.restore(structuredClone(recordingView.fieldView), source.id);
    pendingViewport.current = structuredClone(recordingView.viewport);
    setRetryRevision((v) => v + 1);
  }
  const plannedVideo = source?.live
    ? videoMode === "steps"
      ? videoPlan(
          videoFPS,
          frame?.step ?? source.liveStep ?? 0,
          simulationControl?.run?.performance?.targetStep ??
            (simulationControl?.run?.performance?.targetTime !== undefined &&
            source.dt! > 0
              ? (frame?.step ?? source.liveStep ?? 0) +
                Math.ceil(
                  Math.max(
                    0,
                    simulationControl.run.performance.targetTime -
                      (frame?.time ?? 0),
                  ) / source.dt!,
                )
              : undefined),
          videoEverySteps,
          simulationControl?.run?.performance?.targetStep === undefined,
        )
      : videoPlan(
          videoFPS,
          frame?.time ?? 0,
          simulationControl?.run?.performance?.targetTime,
          videoInterval,
          true,
        )
    : videoPlan(videoFPS, videoStart, videoEnd, videoStride);
  async function finishVideo() {
    const session = videoSession.current;
    if (!session || session.stopping) return;
    session.stopping = true;
    // Drain the last encode/ACK before releasing the solver or packaging output.
    await session.pending;
    try {
      await session.release?.();
    } catch (error) {
      setVideoError(
        `Video saved; reconnect to release capture hold: ${String(error)}`,
      );
    }
    try {
      if (session.encoder.frames)
        saveVideo(
          session.encoder.finish(),
          `${session.name.replace(/[^a-z0-9_-]/gi, "-")}.webm`,
        );
      else session.encoder.dispose();
    } catch (error) {
      setVideoError(String(error));
      session.encoder.dispose();
    }
    if (videoSession.current === session) videoSession.current = null;
    setVideoProgress("");
  }
  async function startVideo() {
    if (!source || !frame || !engine.current || videoSession.current)
      return false;
    if (loading || presentation?.key !== presentationKey) {
      setVideoError(
        "Wait for the configured frame to finish rendering before recording.",
      );
      return false;
    }
    if (
      !validCadence(
        videoFPS,
        videoInterval,
        videoMode === "steps" ? videoEverySteps : undefined,
      )
    ) {
      setVideoError("Choose valid video timing settings.");
      return false;
    }
    const armed = source.live ? source.videoArmed : undefined;
    const fps = videoFPS,
      captureInterval = videoInterval;
    setVideoError("");
    setPlaying(false);
    try {
      const canvas = engine.current.captureCanvas();
      const { width, height } = videoDimensions(canvas);
      if (!(await ViewportVideo.supported(width, height, fps)))
        throw new Error(
          "VP8 video encoding is unavailable in this browser. Try a browser with WebCodecs VideoEncoder support.",
        );
      if (source.live && !simulationControl?.setVideo)
        throw new Error(
          "Update the daemon and simulation adapter for synchronized video capture.",
        );
      const session = {
        encoder: new ViewportVideo(width, height, fps),
        sourceId: source.id,
        name: source.name,
        live: !!source.live,
        end: videoEnd,
        stride: videoStride,
        seen: new Set<string>(),
        pending: Promise.resolve(),
        stopping: false,
        release: source.live
          ? () => simulationControl!.setVideo!(false, captureInterval)
          : undefined,
      };
      const preset: RecordingView = structuredClone({
        version: 1,
        sourceId: source.id,
        field,
        options,
        fieldView: fieldView.preferences,
        viewport: engine.current.viewportSettings(),
        time: frame.time,
      });
      videoSession.current = session;
      try {
        if (source.live)
          await simulationControl!.setVideo!(
            true,
            captureInterval,
            !!armed,
            videoMode === "steps" ? videoEverySteps : undefined,
          );
        if (armed) {
          setVideoFPS(fps);
          setVideoInterval(captureInterval);
          setRetryRevision((v) => v + 1);
        }
        if (!source.live) {
          setIndex(videoStart);
          setRetryRevision((v) => v + 1);
        }
      } catch (error) {
        videoSession.current = null;
        session.encoder.dispose();
        throw error;
      }
      setRecordingView(saveRecordingView(preset));
      setVideoProgress("Waiting for the first rendered frame…");
      setVideoOpen(false);
      return true;
    } catch (error) {
      setVideoError(String(error));
      return false;
    }
  }
  async function playPreparedVideo() {
    if (
      loading ||
      presentation?.key !== presentationKey ||
      videoSession.current
    )
      return;
    const control = simulationControl;
    if (await startVideo()) {
      if (control?.pauseRequested && control.canPause) control.toggle();
    }
  }
  useEffect(() => {
    if (
      !source?.live ||
      !source.videoArmed ||
      !frame ||
      !simulationControl?.setVideo ||
      videoSession.current
    )
      return;
    const key = `${source.id}:${frame.liveRevision}`;
    if (preparedVideo.current === key) return;
    preparedVideo.current = key;
    setVideoFPS(source.videoArmed.fps);
    setVideoInterval(source.videoArmed.interval);
    setVideoMode(source.videoArmed.everySteps ? "steps" : "time");
    if (source.videoArmed.everySteps)
      setVideoEverySteps(source.videoArmed.everySteps);
  }, [sourceId, source?.videoArmed, frame, simulationControl]);
  useEffect(() => {
    const session = videoSession.current;
    if (
      session &&
      (session.sourceId !== sourceId ||
        (session.live &&
          ["completed", "stopped", "failed"].includes(
            simulationControl?.status ?? "",
          )))
    )
      void finishVideo();
  }, [sourceId, simulationControl?.status]);
  const seek = (i: number) => {
    if (videoSession.current && !videoSession.current.live) return;
    setPlaying(false);
    setIndex(i);
  };
  const displayedIndex = frame?.index ?? index;
  const n = frame?.arrays.positions.shape[0] ?? 0;
  const selectedValue =
    selected >= 0 ? engine.current?.values[selected] : undefined;
  const pressure = usePressureProbes(
    registry.current.get(sourceId),
    source,
    displayedIndex,
  );
  const material = useMaterialMotion(registry.current.get(sourceId), source);
  materialPick.current = (uid, frameIndex, pickedSource) => {
    if (
      pickedSource === sourceId &&
      (material.seed || material.busy) &&
      (material.seed?.uids[0] !== uid || material.seed?.index !== frameIndex)
    )
      void material.capture(frameIndex, uid);
  };
  const trace = useParticleTrace(
    registry.current.get(sourceId),
    source,
    displayedIndex,
    traceUid,
  );
  useEffect(() => {
    engine.current?.setProbes(pressure.probes);
    engine.current?.setTrace(trace.rows, displayedIndex);
  }, [
    pressure.probes,
    trace.rows,
    frame,
    displayedIndex,
    options.wrapPeriodic,
  ]);
  useEffect(() => {
    engine.current?.setMaterial(
      material.visible ? material.seed : null,
      material.rows,
      displayedIndex,
      material.fade,
      material.ellipse,
    );
  }, [
    material.seed,
    material.rows,
    material.visible,
    material.fade,
    material.ellipse,
    displayedIndex,
    frame,
    options.wrapPeriodic,
  ]);
  const hasMetric =
    metric !== "material" &&
    metric !== "pressure" &&
    rows.some((r) => r[metric] != null);
  const fixedError =
    options.range === "fixed" &&
    (!(options.max > options.min) ||
      (options.normalization === "log" && options.min <= 0));

  return (
    <div
      className="app-shell"
      data-theme={theme}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void openFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        aria-label="Select trajectory files"
        accept=".h5,.hdf5,.npz,.json"
        multiple
        onChange={(e) => {
          void openFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        className="visually-hidden"
        aria-label="Select snapshot folder"
        multiple
        onChange={(e) => {
          void openFiles(
            Array.from(e.target.files ?? []).filter((f) =>
              /\.(npz|json)$/i.test(f.name),
            ),
          );
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="file-drop-overlay">
          <FolderOpen size={40} />
          <strong>Drop a trajectory to explore it</strong>
          <span>HDF5 file or NPZ snapshots · stays on your device</span>
        </div>
      )}
      <header className="app-header">
        <a
          className="brand"
          href={import.meta.env.BASE_URL}
          aria-label="warpSPH Remote home"
        >
          <span className="brand-mark">
            <Activity size={23} />
          </span>
          <span>
            warp<span className="brand-sph">SPH</span>
            <span className="brand-remote">Remote</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="header-context">Trajectory studio</span>
        <span className="version">PREVIEW 0.1</span>
        <div className="header-actions">
          <button
            className="trajectory-trigger"
            onClick={showPicker}
            aria-label="Choose trajectory"
            title={source?.name}
          >
            <span>
              <strong>
                {source ? friendlyName(source) : "Choose a trajectory"}
              </strong>
              <small>
                {source
                  ? source.live
                    ? `${source.dimension}D · ${source.liveConnected ? "live" : "detached snapshot"}`
                    : `${source.dimension}D · ${source.frames} frames`
                  : "Examples, saved files and uploads"}
              </small>
            </span>
            {demoDownload ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ChevronDown size={15} />
            )}
          </button>
          <button
            className="secondary-button"
            onClick={showPicker}
            aria-label="Open trajectory"
          >
            <FolderOpen size={15} />
            Open trajectory
          </button>

          <IconButton label="Viewer settings" onClick={showSettings}>
            <Settings2 size={18} />
          </IconButton>
          <IconButton
            label="Viewer help"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(false);
              setHelp(true);
            }}
          >
            <Info size={18} />
          </IconButton>
        </div>
      </header>
      <nav className="simulation-toolbar" aria-label="Simulation tasks">
        {(
          [
            ["running", "Running simulations"],
            ["history", "Run history"],
            ["launch", "Run simulation"],
            [
              "connection",
              daemonConnected ? "Daemon connected" : "Connect daemon",
            ],
          ] as const
        ).map(([section, label]) => (
          <button
            key={section}
            className="secondary-button"
            onClick={() => {
              setCompanionSection(section);
              setCompanionOpen(true);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className={`workspace ${inspector ? "" : "inspector-hidden"}`}>
        <aside
          className="analysis-panel"
          aria-label="Frame information and diagnostics"
        >
          <div className="inspector-title">
            <span>FRAME & DIAGNOSTICS</span>
            <Target size={15} />
          </div>
          <section className="inspector-section">
            <div className="section-heading">CURRENT FRAME</div>
            <div className="metric-large">
              {n.toLocaleString()}
              <span>particles</span>
            </div>
            <dl className="properties">
              <dt>Fluid particles</dt>
              <dd>{current?.particles.toLocaleString() ?? "—"}</dd>
              <dt>Dimension</dt>
              <dd>{source?.dimension ?? "—"}D</dd>
              <dt>Simulation time</dt>
              <dd>
                {source?.timeKind === "simulation"
                  ? formatNumber(frame?.time ?? 0, 5)
                  : "Not recorded"}
              </dd>
              <dt>Frame size</dt>
              <dd>{frame ? `${(frame.bytes / 1e6).toFixed(2)} MB` : "—"}</dd>
            </dl>
          </section>
          {simulationControl && (
            <>
              <LiveMetrics
                control={simulationControl}
                viewer={{
                  reconstructing: loading,
                  encoding: videoEncoding,
                  renderMs,
                  prepareMs,
                  encodeMs: videoEncodeMs,
                }}
              />
              {simulationControl?.run?.video?.active &&
                (!videoSession.current ||
                  simulationControl.run.video.orphaned) && (
                  <div className="capture-hold-note">
                    <p>
                      {source?.videoArmed
                        ? "Simulation initialized and paused. Configure the visualization, then press Play to record that view and start the simulation."
                        : "Video capture is holding this simulation. Resume with Export video, or release the capture hold to continue normal monitoring."}
                    </p>
                    {videoSession.current && (
                      <button
                        className="secondary-button"
                        onClick={() =>
                          void simulationControl
                            .setVideo?.(
                              true,
                              videoInterval,
                              false,
                              videoMode === "steps"
                                ? videoEverySteps
                                : undefined,
                            )
                            .catch((error) => setVideoError(String(error)))
                        }
                      >
                        Resume video capture
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      onClick={() => {
                        if (videoSession.current) void finishVideo();
                        else
                          void simulationControl
                            .setVideo?.(false, 0.04)
                            .catch((error) => setVideoError(String(error)));
                      }}
                    >
                      Release video capture hold
                    </button>
                  </div>
                )}
              <section className="inspector-section">
                <button
                  className="secondary-button"
                  disabled={!simulationControl.configurationAvailable}
                  onClick={() => {
                    setConfigurationView({ loading: true });
                    simulationControl
                      .inspectConfiguration?.()
                      .then((data) =>
                        setConfigurationView({ loading: false, data }),
                      )
                      .catch((error) =>
                        setConfigurationView({
                          loading: false,
                          error: error.message,
                        }),
                      );
                  }}
                >
                  Inspect simulation configuration
                </button>
              </section>
            </>
          )}
          <DiagnosticsPanel
            current={current}
            metrics={activeMetrics}
            onChange={(keys) => {
              setActiveMetrics(keys);
              if (
                activeMetrics.includes(metric as DiagnosticMetric) &&
                !keys.includes(metric as DiagnosticMetric)
              )
                setMetric(keys[0] ?? "pressure");
            }}
            onSelect={(value) => {
              setMetric(value);
              setChartsExpanded(true);
            }}
          />
          <details className="control-disclosure control-section">
            <summary>Appearance</summary>
            <div className="label-row">
              <label htmlFor="size">Particle scale</label>
              <span className="mono">{options.size.toFixed(2)}×</span>
            </div>
            <input
              id="size"
              className="slider"
              type="range"
              min="0.25"
              max="2.5"
              step="0.05"
              value={options.size}
              onChange={(e) => setOption("size", +e.target.value)}
            />
            <div className="toggle-row">
              <span>Physical particle size</span>
              <Toggle
                label="Physical particle size"
                value={options.physical}
                onChange={(v) => setOption("physical", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Boundary particles</span>
              <Toggle
                label="Boundary particles"
                value={options.boundaries}
                onChange={(v) => setOption("boundaries", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Ghost particles</span>
              <Toggle
                label="Ghost particles"
                value={options.ghosts}
                onChange={(v) => setOption("ghosts", v)}
              />
            </div>
            <div className="toggle-row">
              <span>Reference grid</span>
              <Toggle
                label="Reference grid"
                value={options.grid}
                onChange={(v) => setOption("grid", v)}
              />
            </div>
            {source?.dimension === 3 && (
              <section className="inspector-section">
                <div className="section-heading">CLIPPING</div>
                <div className="select-wrap">
                  <select
                    aria-label="Clipping axis"
                    value={options.clipAxis}
                    onChange={(e) => setOption("clipAxis", +e.target.value)}
                  >
                    <option value="-1">Show full volume</option>
                    <option value="0">Clip along X</option>
                    <option value="1">Clip along Y</option>
                    <option value="2">Clip along Z</option>
                  </select>
                  <ChevronDown size={13} />
                </div>
                {options.clipAxis >= 0 && (
                  <>
                    <div className="label-row">
                      <span>Visible extent</span>
                      <span>{Math.round(options.clip * 100)}%</span>
                    </div>
                    <input
                      className="slider"
                      aria-label="Clipping position"
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={options.clip}
                      onChange={(e) => setOption("clip", +e.target.value)}
                    />
                  </>
                )}
              </section>
            )}
          </details>
          <div className="inspector-bottom">
            <Eye size={14} />
            <span>
              {source?.live
                ? source.liveConnected
                  ? "Live snapshot"
                  : "Detached snapshot"
                : "Viewing recorded data"}
              <br />
              <button
                onClick={() => {
                  setCompanionSection("running");
                  setCompanionOpen(true);
                }}
              >
                {source?.live ? "Simulation manager" : "Connect a simulation"}
              </button>
            </span>
          </div>
        </aside>
        <main className="main-panel">
          <div className="viewport-heading">
            <div>
              <div className="eyebrow">
                {source?.live
                  ? `${source.liveConnected ? "LIVE SIMULATION" : "DETACHED SNAPSHOT"} · STEP ${frame?.step ?? source.liveStep ?? "—"}`
                  : source?.format === "Analytical demo"
                    ? "ANALYTICAL FIELD"
                    : "RECORDED TRAJECTORY"}
              </div>
              <h1>
                {source ? friendlyName(source) : "Your simulation, in view."}
              </h1>
            </div>
            <div className="viewport-heading-actions">
              {recordingView?.sourceId === sourceId && (
                <button
                  className="small-button"
                  onClick={restoreRecordingPreset}
                  disabled={loading}
                  title="Restore quantity, colors, grid, flow and camera from the start of recording"
                >
                  Restore recording view
                </button>
              )}
              {source &&
                (source.format === "Recorded demo" ||
                  !source.id.startsWith("demo-")) && (
                  <IconButton label="Close trajectory" onClick={closeCurrent}>
                    <X size={16} />
                  </IconButton>
                )}
              <span className="dimension-badge">
                {source?.dimension ?? "—"}D{" "}
                {source?.dimension === 1
                  ? "PROFILE"
                  : displayMode === "particles"
                    ? "PARTICLES"
                    : displayMode === "both"
                      ? "GRID + PARTICLES"
                      : "SCALAR GRID"}
              </span>
              <IconButton
                label="Toggle visualization controls"
                active={inspector}
                onClick={() => setInspector((v) => !v)}
              >
                <Settings2 size={16} />
              </IconButton>
            </div>
          </div>
          <section
            className={`viewport ${source?.dimension === 1 ? "profile-viewport" : ""} ${options.background === "light" ? "light" : ""} ${selection && (selected >= 0 || selection.uid) ? "has-particle-selection" : ""} ${picking ? "picking" : ""}`}
            aria-label="Particle visualization"
          >
            <div className="scene-host" ref={host} />
            {(videoProgress || videoError) && (
              <div className="video-status" role="status">
                {videoError || videoProgress}
                {videoError && (
                  <button
                    className="secondary-button compact"
                    onClick={() => setVideoError("")}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
            <div className="scene-title">
              <strong>{source ? friendlyName(source) : "warpSPH"}</strong>
              <span>
                <span className="scene-title-dot" /> {scalarTitle}
                {loading && !playing ? " · Updating…" : ""}
              </span>
              {source && (
                <span className="scene-time">
                  {source.timeKind === "simulation" ? "t = " : "frame "}
                  {formatNumber(frame?.time ?? 0, 5)}
                  {source.dt !== undefined
                    ? ` · Δt = ${formatNumber(source.dt, 4)}`
                    : ""}
                  {source.scheme ? ` · ${source.scheme}` : ""}
                  {source.kernel ? ` · ${source.kernel}` : ""}
                  {source.integrator ? ` · ${source.integrator}` : ""}
                  {presentation?.mode !== "particles"
                    ? ` · Grid kernel ${fieldView.settings.kernel === "wendland4" ? "C4" : "C2"}`
                    : ""}
                </span>
              )}
            </div>
            <div className="scene-tools">
              {source?.dimension === 1 && (
                <button
                  className="secondary-button compact"
                  onClick={() => {
                    if (engine.current instanceof ProfileRenderer) {
                      engine.current.follow = !engine.current.follow;
                      if (engine.current.follow) engine.current.fit();
                    }
                    setProfileFollow(
                      engine.current instanceof ProfileRenderer
                        ? engine.current.follow
                        : true,
                    );
                  }}
                >
                  {profileFollow
                    ? "Follow profile extents"
                    : "Fixed profile axes"}
                </button>
              )}
              <button
                className="secondary-button compact"
                disabled={!frame || (loading && !videoSession.current)}
                onClick={() => {
                  if (videoSession.current) void finishVideo();
                  else {
                    setVideoStart(index);
                    setVideoEnd(Math.max(index, (source?.frames ?? 1) - 1));
                    setVideoOpen(true);
                    setVideoError("");
                  }
                }}
              >
                {videoSession.current ? "Finish & save video" : "Export video"}
              </button>
              <IconButton
                label="Pick a particle (P)"
                active={picking}
                disabled={!frame}
                onClick={() => {
                  setPlaying(false);
                  setPicking((v) => !v);
                }}
              >
                <MousePointer2 size={17} />
              </IconButton>
              <IconButton
                label="Fit current frame (F)"
                onClick={() => engine.current?.fit()}
              >
                <Maximize size={17} />
              </IconButton>
              <IconButton
                label="Export scene as PNG"
                onClick={() => engine.current?.exportImage()}
                disabled={!frame}
              >
                <ArrowDownToLine size={17} />
              </IconButton>
            </div>
            {loading && (!playing || !frame) && (
              <div className="loading-badge">
                <LoaderCircle size={13} className="spin" />
                {fieldView.active ? "Reconstructing frame" : "Reading frame"}
              </div>
            )}
            {(error || engineError || reconstructionWarning) && (
              <div className="scene-warning" role="alert">
                <Info size={18} />
                <div>
                  <strong>
                    {reconstructionWarning
                      ? "Grid reconstruction unavailable"
                      : "Could not update this view"}
                  </strong>
                  <p>{engineError || error || reconstructionWarning}</p>
                  {reconstructionWarning && (
                    <p>Showing particles. Your data remains loaded.</p>
                  )}
                  <div className="scene-warning-actions">
                    {(!engineError || engine.current) && (
                      <button
                        className="secondary-button"
                        onClick={() => setRetryRevision((v) => v + 1)}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setError("");
                        setEngineError("");
                        setReconstructionWarning("");
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!frame && !loading && !error && !engineError && (
              <div className="scene-message">
                <Layers size={30} />
                <strong>Open a trajectory to begin</strong>
                <p>Explore recorded SPH data with a GPU-rendered scene.</p>
                <button className="primary-button" onClick={showPicker}>
                  Open trajectory
                </button>
              </div>
            )}
            {picking && !selection && (
              <div className="pick-hint" role="status">
                {fieldView.waitingForSeed
                  ? "Click a particle to seed the streamline · drag to pan"
                  : "Click a particle to inspect · drag to pan"}
              </div>
            )}
            {selection?.sourceId === sourceId &&
              frame &&
              (selected >= 0 || selection.uid) && (
                <section
                  className="particle-card"
                  aria-label="Selected particle"
                >
                  <div className="particle-card-heading">
                    <MousePointer2 size={14} />
                    <strong>
                      {selection.uid != null
                        ? `UID ${selection.uid}`
                        : `Particle ${selected}`}
                    </strong>
                    <label className="particle-trace-toggle">
                      <input
                        type="checkbox"
                        aria-label="Show particle trace"
                        checked={trace.enabled}
                        disabled={
                          source?.identity !== "UIDs" ||
                          !!source?.live ||
                          source?.dimension === 1
                        }
                        onChange={(e) => trace.setEnabled(e.target.checked)}
                      />
                      Trace
                    </label>
                    <IconButton
                      label="Clear particle selection"
                      onClick={clearSelection}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                  {selected >= 0 ? (
                    <dl className="properties">
                      <dt>Array index</dt>
                      <dd>{selected}</dd>
                      {selectedPosition.map((v, c) => (
                        <span className="property-pair" key={c}>
                          <dt>{"XYZ"[c]}</dt>
                          <dd>{formatNumber(v, 5)}</dd>
                        </span>
                      ))}
                      <dt>{fieldLabel(presentation?.field ?? field)}</dt>
                      <dd>
                        {selectedValue == null
                          ? "—"
                          : formatNumber(selectedValue, 5)}
                      </dd>
                      <dt>Kind</dt>
                      <dd>{String(frame.arrays.kinds.data[selected])}</dd>
                    </dl>
                  ) : (
                    <p className="subtle-note">
                      This UID is absent from the current frame. Its recorded
                      trace remains available.
                    </p>
                  )}
                  {(trace.enabled || source?.identity !== "UIDs") && (
                    <TraceControls
                      trace={trace}
                      uid={traceUid}
                      supported={
                        source?.identity === "UIDs" &&
                        !source.live &&
                        source.dimension !== 1
                      }
                      onClear={clearSelection}
                      compact
                      hideToggle
                    />
                  )}
                  {source?.live && (
                    <p className="subtle-note">
                      Live snapshots update without retaining particle history.
                      Traces, material tracking and FTLE require a recording.
                    </p>
                  )}
                  <MaterialCapture
                    motion={material}
                    index={displayedIndex}
                    uid={traceUid}
                    supported={
                      source?.identity === "UIDs" &&
                      !source.live &&
                      source.dimension !== 1
                    }
                    onOpen={() => {
                      setMetric("material");
                      setChartsExpanded(true);
                    }}
                  />
                </section>
              )}
            {frame && (
              <>
                <div className="scene-caption">
                  <span>{n.toLocaleString()} particles</span>
                  <span>
                    {source?.dimension === 3 ? (
                      <Rotate3D size={12} />
                    ) : (
                      <MousePointer2 size={12} />
                    )}{" "}
                    {source?.dimension === 3 ? "Drag to orbit" : "Drag to pan"}{" "}
                    · Scroll to zoom
                  </span>
                </div>
                <div className="color-legend">
                  <div className="legend-title">
                    {scalarTitle}
                    {displayedOptions.normalization === "cyclic" &&
                    displayedOptions.colorPeriod > 0
                      ? ` · modulo ${displayedOptions.colorPeriod}`
                      : ""}
                  </div>
                  <div
                    className="legend-gradient"
                    style={{ background: gradient(displayedOptions.palette) }}
                  />
                  <div className="legend-values">
                    <span>{formatNumber(range[0], 4)}</span>
                    <span>{formatNumber(range[1], 4)}</span>
                  </div>
                  {!validRange && (
                    <span className="invalid-note">
                      No valid fluid values · shown gray
                    </span>
                  )}
                </div>
                <svg
                  className="orientation"
                  viewBox="0 0 54 54"
                  aria-label="Camera orientation"
                >
                  {axes.slice(0, source?.dimension ?? 2).map(([x, y], c) => (
                    <g
                      key={c}
                      stroke={["#d88d82", "#74bf9c", "#8baee4"][c]}
                      fill={["#d88d82", "#74bf9c", "#8baee4"][c]}
                    >
                      <line x1="27" y1="27" x2={27 + x * 17} y2={27 - y * 17} />
                      <text
                        x={27 + x * 24}
                        y={30 - y * 24}
                        textAnchor="middle"
                        stroke="none"
                        fontSize="8"
                      >
                        {"XYZ"[c]}
                      </text>
                    </g>
                  ))}
                </svg>
              </>
            )}
          </section>
          <section
            className="transport"
            aria-label="Trajectory playback"
            inert={!!videoSession.current && !source?.live}
          >
            <div className="transport-buttons">
              <IconButton
                label="First frame"
                onClick={() => seek(0)}
                disabled={!source || index === 0}
              >
                <ChevronsLeft size={17} />
              </IconButton>
              <IconButton
                label="Previous frame"
                onClick={() => seek(Math.max(0, index - 1))}
                disabled={!source || index === 0}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <button
                className="play-button"
                aria-label={
                  source?.live
                    ? source.videoArmed && !videoSession.current
                      ? "Start video and simulation"
                      : simulationControl?.pauseRequested
                        ? "Resume simulation"
                        : "Pause simulation"
                    : playing
                      ? "Pause playback"
                      : "Play trajectory"
                }
                title={
                  source?.live && !simulationControl?.canPause
                    ? "Reconnect to the companion to control this simulation"
                    : undefined
                }
                disabled={
                  source?.live
                    ? !simulationControl?.canPause ||
                      simulationControl.busy ||
                      (!!source.videoArmed &&
                        !videoSession.current &&
                        (loading || presentation?.key !== presentationKey))
                    : !source || source.frames < 2 || !!error
                }
                onClick={() => {
                  if (source?.live) {
                    if (source.videoArmed && !videoSession.current)
                      void playPreparedVideo();
                    else simulationControl?.toggle();
                    return;
                  }
                  if (source && index === source.frames - 1 && !loop)
                    setIndex(0);
                  setPlaying((v) => !v);
                }}
              >
                {(
                  source?.live
                    ? simulationControl && !simulationControl.pauseRequested
                    : playing
                ) ? (
                  <Pause size={17} fill="currentColor" />
                ) : (
                  <Play size={17} fill="currentColor" />
                )}
              </button>
              <IconButton
                label="Next frame"
                onClick={() =>
                  seek(Math.min((source?.frames ?? 1) - 1, index + 1))
                }
                disabled={!source || index >= source.frames - 1}
              >
                <ChevronRight size={18} />
              </IconButton>
              <IconButton
                label="Last frame"
                onClick={() => seek((source?.frames ?? 1) - 1)}
                disabled={!source || index >= source.frames - 1}
              >
                <ChevronsRight size={17} />
              </IconButton>
            </div>
            {source?.live && simulationControl?.toggleTransfers && (
              <button
                className="secondary-button live-update-toggle"
                aria-label={
                  simulationControl.transfersPaused
                    ? "Resume live updates"
                    : "Pause live updates"
                }
                title="Pause snapshot downloads independently of simulation execution"
                onClick={simulationControl.toggleTransfers}
                disabled={!!simulationControl.run?.video?.active}
              >
                {simulationControl.transfersPaused ? (
                  <Play size={14} />
                ) : (
                  <Pause size={14} />
                )}
                {simulationControl.transfersPaused
                  ? "Resume updates"
                  : "Pause updates"}
              </button>
            )}
            <div className="scrubber">
              <div className="scrubber-info">
                <span>
                  {source?.live ? "LIVE SNAPSHOT " : "FRAME "}
                  <strong>
                    {source?.live
                      ? (frame?.liveRevision ?? source.liveRevision)
                      : String(displayedIndex + 1).padStart(3, "0")}
                  </strong>
                  {source?.live && simulationControl && (
                    <span className="muted">
                      {" "}
                      ·{" "}
                      {simulationControl.status === "paused"
                        ? simulationControl.pauseRequested
                          ? "Paused"
                          : "Resuming…"
                        : simulationControl.pauseRequested
                          ? "Pausing…"
                          : simulationControl.status}
                    </span>
                  )}
                  {index !== displayedIndex && (
                    <span className="muted"> → {index + 1}</span>
                  )}
                  <span className="muted">
                    {" "}
                    {!source?.live &&
                      `/ ${String(source?.frames ?? 0).padStart(3, "0")}`}
                  </span>
                </span>
                <span>
                  {source?.timeKind === "simulation"
                    ? "SIMULATION TIME"
                    : "FRAME INDEX"}{" "}
                  <strong>
                    {formatNumber(
                      frame?.time ?? source?.times[displayedIndex] ?? 0,
                      5,
                    )}
                  </strong>
                </span>
              </div>
              <input
                className="slider timeline"
                aria-label="Trajectory frame"
                type="range"
                min="0"
                max={Math.max(0, (source?.frames ?? 1) - 1)}
                value={index}
                disabled={!source || source.live}
                onChange={(e) => seek(+e.target.value)}
              />
            </div>
            <select
              className="speed-select"
              aria-label="Playback speed"
              disabled={!source || !!source.live}
              value={speed}
              onChange={(e) => setSpeed(+e.target.value)}
            >
              {[0.25, 0.5, 1, 2, 4].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
            <IconButton
              label="Loop playback"
              disabled={!source || !!source.live}
              active={loop}
              onClick={() => setLoop((v) => !v)}
            >
              <Repeat2 size={17} />
            </IconButton>
          </section>
          <section
            className={`diagnostics ${metric === "pressure" || metric === "material" ? "pressure-active" : ""} ${chartsExpanded ? "" : "collapsed"}`}
          >
            <div className="diagnostics-heading">
              <div className="section-heading">
                <Activity size={14} />
                <span>DIAGNOSTICS</span>
              </div>
              <div
                className="diagnostic-tabs"
                role="group"
                aria-label="Diagnostic quantity"
              >
                {(
                  [
                    ...activeMetrics.map(
                      (id) => [id, metricDefinitions[id].label] as const,
                    ),
                    ["pressure", "Pressure probes"],
                    ["material", "Material motion"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={metric === id ? "selected" : ""}
                    aria-pressed={metric === id}
                    disabled={!!source?.live && id === "material"}
                    onClick={() => {
                      setMetric(id);
                      setChartsExpanded(true);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <IconButton
                label={
                  chartsExpanded ? "Collapse diagnostics" : "Expand diagnostics"
                }
                active={chartsExpanded}
                onClick={() => setChartsExpanded((v) => !v)}
              >
                <ChevronDown size={15} />
              </IconButton>
              <span className="diagnostic-progress">
                {rows.length < (source?.frames ?? 0)
                  ? `${rows.length} / ${source?.frames} frames`
                  : "Fluid particles only"}
              </span>
            </div>
            {chartsExpanded && (
              <>
                <div className="diagnostic-body">
                  {metric === "material" && (
                    <div className="material-tools-host">
                      <MaterialTools
                        motion={material}
                        uid={traceUid}
                        supported={
                          source?.identity === "UIDs" &&
                          !source.live &&
                          source.dimension !== 1
                        }
                        onPickSeed={() => {
                          setPlaying(false);
                          setPicking(true);
                        }}
                        index={displayedIndex}
                        timeKind={source?.timeKind}
                      />
                    </div>
                  )}
                  {metric === "pressure" && (
                    <>
                      <PressureControls
                        controller={pressure}
                        selectedPosition={selectedPosition}
                      />
                      {simulationControl?.setDiagnosticProbes && (
                        <button
                          className="secondary-button"
                          onClick={() =>
                            void simulationControl.setDiagnosticProbes!(
                              pressure.probes,
                            )
                              .then(() =>
                                setStorageStatus(
                                  "Run probe logging updated; retained in Run report.",
                                ),
                              )
                              .catch((e) => setDiagnosticError(String(e)))
                          }
                        >
                          Record configured probes for this run
                        </button>
                      )}
                    </>
                  )}
                  {source &&
                    (metric === "material" ? (
                      <MaterialChart
                        motion={material}
                        source={source}
                        index={displayedIndex}
                        onSeek={seek}
                        theme={theme}
                      />
                    ) : metric === "pressure" ? (
                      <PressureChart
                        theme={theme}
                        rows={pressure.samples}
                        probes={pressure.probes}
                        source={source}
                        index={displayedIndex}
                        onSeek={seek}
                      />
                    ) : (
                      <DiagnosticChart
                        theme={theme}
                        rows={rows}
                        source={source}
                        metric={metric}
                        index={displayedIndex}
                      />
                    ))}
                </div>
                <div className="chart-note">
                  {source?.live ? (
                    "Live diagnostics and probes sample displayed snapshots only (last 600). Skipped simulation steps and particle history are not retained."
                  ) : metric === "material" ? (
                    "Frozen UID set; seed-time periodic branch plus original unwrapped motion. 2D FTLE masks fits above relative residual 0.25. The ellipse is the fitted image of the seed RMS circle; sparse exports and particle shifting affect interpretation. Click a chart sample to seek."
                  ) : metric === "pressure" ? (
                    pressure.probes.length ? (
                      "Click a pressure sample to jump to its recorded frame. Add or edit fixed points in this tab; generate histories to scan the recording."
                    ) : (
                      "Add a pressure probe in this tab, then generate its history. Pressure must be present in the recording."
                    )
                  ) : diagnosticError ? (
                    <span className="inline-error">{diagnosticError}</span>
                  ) : rows.length > 0 && !hasMetric ? (
                    "This quantity is unavailable in this trajectory. Missing values are not replaced with zeros."
                  ) : source?.format === "Analytical demo" ? (
                    source.dimension === 1 ? (
                      "Prescribed 1D contraction for viewer testing; not a solver trajectory."
                    ) : (
                      "Analytical field sampled on a fixed lattice; this is not an advected solver trajectory."
                    )
                  ) : (
                    "Computed from recorded numerical arrays. Playback slows when reading takes longer than the requested interval."
                  )}
                </div>
              </>
            )}
          </section>
        </main>
        {inspector && (
          <aside
            className="visualization-panel"
            aria-label="Visualization controls"
          >
            <div className="inspector-title">
              <span>VISUALIZATION</span>
              <SlidersHorizontal size={15} />
            </div>
            <section className="control-section">
              <button
                className="secondary-button"
                disabled={!source}
                onClick={() => {
                  if (!source) return;
                  const p = sourcePreset(source);
                  p.view.settings.backend = fieldView.settings.backend;
                  setPlaying(false);
                  setIndex(p.index);
                  setField(p.field);
                  setOptions((old) => ({ ...old, ...p.options }));
                  fieldView.restore(p.view, source.id);
                  setActiveMetrics(p.metrics);
                }}
              >
                Recommended example view
              </button>
            </section>
            <section className="control-section">
              <button
                className="secondary-button"
                onClick={() =>
                  setShareLink(
                    buildViewURL(
                      location.href,
                      source!,
                      displayedIndex,
                      field,
                      options,
                      fieldView.preferences,
                      activeMetrics,
                      theme,
                      metric,
                      analysisPreferences,
                      quantityAnalysis,
                    ),
                  )
                }
                disabled={!source}
              >
                Share view link
              </button>
              {shareLink && (
                <>
                  <input
                    aria-label="View URL"
                    readOnly
                    value={shareLink}
                    onFocus={(e) => e.target.select()}
                  />
                  <p className="subtle-note">
                    Copy this URL. Local files stay on the viewer's device.
                  </p>
                </>
              )}
            </section>
            <details className="control-disclosure control-section color-disclosure">
              <summary>
                <span
                  className="mapping-preview"
                  style={{ background: gradient(options.palette) }}
                />
                <span>
                  Color mapping
                  <small>
                    {scalarTitle} · {options.normalization}
                  </small>
                </span>
              </summary>
              <label className="control-label" htmlFor="color-preset">
                Mapping preset
              </label>
              <select
                id="color-preset"
                value=""
                onChange={(e) => {
                  const preset = colorPresets.find(
                    (p) => p.id === e.target.value,
                  );
                  if (!preset) return;
                  setField(preset.field);
                  fieldView.setSettings((old) => ({
                    ...old,
                    quantity: preset.quantity,
                  }));
                  if (preset.quantity !== "field") fieldView.setMode("grid");
                  if (categoricalField(preset.field)) {
                    fieldView.setMode("particles");
                    fieldView.setLIC(false);
                  }
                  setOptions((old) => ({
                    ...old,
                    palette: preset.palette,
                    normalization: preset.normalization,
                    colorPeriod: preset.colorPeriod ?? old.colorPeriod,
                    mapping: preset.mapping,
                    range: "frame",
                  }));
                }}
              >
                <option value="">Custom mapping</option>
                {colorPresets
                  .filter((p) => source?.fields.some((f) => f.name === p.field))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
              <label className="control-label" htmlFor="field">
                Mapped quantity
              </label>
              <div className="select-wrap">
                <select
                  id="field"
                  value={
                    fieldView.mode !== "particles" &&
                    derivativeQuantity(fieldView.settings.quantity)
                      ? "@" + fieldView.settings.quantity
                      : field
                  }
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.startsWith("@")) {
                      fieldView.setSettings((old) => ({
                        ...old,
                        quantity: value.slice(1) as "vorticity" | "divergence",
                      }));
                      fieldView.setMode("grid");
                      setOptions((old) => ({
                        ...old,
                        palette: "coolwarm",
                        normalization: "linear",
                        range: "frame",
                      }));
                    } else {
                      setField(value);
                      if (["UIDs", "kinds", "materials"].includes(value)) {
                        fieldView.setMode("particles");
                        fieldView.setLIC(false);
                      }
                      fieldView.setSettings((old) => ({
                        ...old,
                        quantity: "field",
                      }));
                    }
                  }}
                  disabled={!source}
                >
                  {source?.dimension === 2 &&
                    source.fields.some((f) => f.name === "velocities") && (
                      <optgroup label="Derived velocity">
                        <option value="@vorticity">Vorticity</option>
                        <option value="@divergence">Velocity divergence</option>
                      </optgroup>
                    )}
                  {source?.fields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {fieldLabel(f.name)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              {isVector && !shownDerivative && (
                <div
                  className="segmented mapping"
                  role="group"
                  aria-label="Vector component"
                >
                  {(
                    [
                      "magnitude",
                      "x",
                      "y",
                      ...(currentField!.components >= 3 ? ["z"] : []),
                    ] as ViewOptions["mapping"][]
                  ).map((m) => (
                    <button
                      key={m}
                      className={options.mapping === m ? "selected" : ""}
                      onClick={() => setOption("mapping", m)}
                    >
                      {m === "magnitude" ? "Magnitude" : m.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              <label className="control-label" htmlFor="palette">
                Color palette
              </label>
              <div className="palette-select">
                <div
                  className="palette-strip"
                  style={{ background: gradient(options.palette) }}
                />
                <div className="select-wrap">
                  <select
                    id="palette"
                    value={options.palette}
                    onChange={(e) => setOption("palette", e.target.value)}
                  >
                    {Object.entries(palettes).map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.label} · {p.category}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </div>
              </div>
              <label className="control-label" htmlFor="normalization">
                Normalization
              </label>
              <div className="select-wrap">
                <select
                  id="normalization"
                  value={options.normalization}
                  onChange={(e) =>
                    setOption(
                      "normalization",
                      e.target.value as ViewOptions["normalization"],
                    )
                  }
                >
                  <option value="linear">Linear</option>
                  <option value="log">Logarithmic</option>
                  <option value="symlog">Symmetric log · threshold 1</option>
                  <option value="cyclic">Periodic · 0 disables wrapping</option>
                </select>
                <ChevronDown size={13} />
              </div>
              {options.normalization === "cyclic" && (
                <>
                  <label className="control-label">
                    Color period
                    <NumberControl
                      aria-label="Color period"
                      min={0}
                      max={1e9}
                      step={1}
                      value={options.colorPeriod}
                      onValueChange={(value) => {
                        if (
                          Number.isInteger(value) &&
                          value >= 0 &&
                          value <= 1e9
                        )
                          setOption("colorPeriod", value);
                      }}
                    />
                  </label>
                  <p className="subtle-note">
                    {options.colorPeriod === 0
                      ? "No wrapping: colors span the full value range. Set a positive period to repeat colors."
                      : `Colors repeat every ${options.colorPeriod} units. Set 0 for no wrapping.`}
                  </p>
                </>
              )}
              {(options.normalization !== "cyclic" ||
                options.colorPeriod === 0) && (
                <>
                  <div className="label-row">
                    <span>Color range</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        setOptions((o) => ({
                          ...o,
                          range: o.range === "frame" ? "fixed" : "frame",
                          min: range[0],
                          max: range[1],
                        }))
                      }
                    >
                      {options.range === "frame"
                        ? "Auto · per frame"
                        : "Fixed range"}
                    </button>
                  </div>
                  <div className="range-inputs">
                    <label>
                      <span>MIN</span>
                      <NumberControl
                        aria-label="Minimum color value"
                        step="any"
                        disabled={options.range === "frame"}
                        value={
                          options.range === "frame"
                            ? Number(range[0].toPrecision(5))
                            : options.min
                        }
                        onValueChange={(value) => setOption("min", value)}
                      />
                    </label>
                    <span>—</span>
                    <label>
                      <span>MAX</span>
                      <NumberControl
                        aria-label="Maximum color value"
                        step="any"
                        disabled={options.range === "frame"}
                        value={
                          options.range === "frame"
                            ? Number(range[1].toPrecision(5))
                            : options.max
                        }
                        onValueChange={(value) => setOption("max", value)}
                      />
                    </label>
                  </div>
                  {fixedError && (
                    <p className="inline-error">
                      Maximum must exceed minimum; logarithmic bounds must be
                      positive. Showing automatic range.
                    </p>
                  )}
                </>
              )}
            </details>
            <section
              className="control-section quantity-analysis-panel"
              aria-label="Mapped quantity analysis"
            >
              <div className="section-heading">
                <Activity size={14} />
                <span>QUANTITY ANALYSIS</span>
              </div>
              <button
                className="secondary-button"
                disabled={
                  (source?.frames ?? 0) < 2 ||
                  source?.dimension !== 2 ||
                  source?.identity !== "UIDs" ||
                  source?.timeKind !== "simulation"
                }
                onClick={() => {
                  setPlaying(false);
                  setFTLEOpen(true);
                }}
              >
                Spatial FTLE map
              </button>

              <button
                className="secondary-button"
                disabled={!source}
                onClick={() => {
                  setPlaying(false);
                  setProfilesOpen(true);
                }}
              >
                Profile / scatter plots
              </button>
              <div
                className="quantity-analysis-tabs"
                role="group"
                aria-label="Mapped quantity analysis view"
              >
                {(
                  [
                    ["histogram", "Histogram"],
                    ["spectrum", "Spectrum"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={quantityAnalysis === id ? "selected" : ""}
                    aria-pressed={quantityAnalysis === id}
                    disabled={
                      !source || (id === "spectrum" && source.dimension !== 2)
                    }
                    onClick={() =>
                      setQuantityAnalysis((old) => (old === id ? null : id))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {source && quantityAnalysis && (
                <>
                  <QuantityAnalysis
                    key={sourceId + quantityAnalysis}
                    reader={registry.current.get(sourceId)!}
                    revision={source.liveRevision}
                    index={displayedIndex}
                    field={presentation?.field ?? field}
                    mapping={options.mapping}
                    grid={
                      (presentation?.mode !== "particles"
                        ? fieldView.query(
                            displayedIndex,
                            field,
                            options.mapping,
                            options.wrapPeriodic,
                          )
                        : null) ?? {
                        index: displayedIndex,
                        field,
                        mapping: options.mapping,
                        settings: {
                          ...fieldView.settings,
                          quantity: "field",
                          wrapPeriodic: options.wrapPeriodic,
                        },
                        streams: null,
                      }
                    }
                    gridVisible={
                      !!presentation && presentation.mode !== "particles"
                    }
                    mode={quantityAnalysis}
                    theme={theme}
                    playing={playing}
                    initial={analysisPreferences}
                    onSettings={setAnalysisPreferences}
                  />
                  <p className="subtle-note">
                    {quantityAnalysis === "histogram"
                      ? "Distribution of the mapped quantity in original units; excludes boundaries and invalid samples."
                      : "Spatial spectrum of the mapped scalar, not kinetic energy. Masking and windowing affect the result."}
                  </p>
                </>
              )}
            </section>
            <FieldControls
              canReconstruct={!categoricalMapping}
              onRequestSeed={() => {
                setPlaying(false);
                setPicking(true);
              }}
              view={{
                ...fieldView,
                result: presentation?.result ?? null,
                busy: loading && fieldView.active && !playing,
                error: fieldView.active ? error : "",
              }}
              dimension={source?.dimension}
              hasVelocity={
                source?.fields.some(
                  (f) => f.name === "velocities" && f.components >= 2,
                ) ?? false
              }
              onQuantityChange={(quantity) => {
                if (derivativeQuantity(quantity))
                  setOptions((old) => ({
                    ...old,
                    palette: "coolwarm",
                    normalization: "linear",
                    range: "frame",
                  }));
              }}
            />
            <div className="sidebar-foot">
              <span className="tiny-dot" />
              {source?.dimension === 1
                ? "Browser-rendered · Canvas 2D profiles"
                : "Browser-rendered · WebGL2"}
            </div>
          </aside>
        )}
      </div>
      <footer className="status-bar">
        <span>
          <span className="tiny-dot" />
          {source?.format ?? "No source"}
          <span className="status-separator">/</span>
          {playing
            ? fieldView.active
              ? "Playing reconstructed frames"
              : "Playing trajectory"
            : loading
              ? fieldView.active
                ? "Updating grid · showing last completed frame"
                : "Reading snapshot"
              : "Ready to inspect"}
        </span>
        <span>
          {storageStatus && (
            <span className="storage-status" title={storageStatus}>
              {storageStatus}
              <span className="status-separator">/</span>
            </span>
          )}
          Prepare frame {fetchMs.toFixed(1)} ms
          <span className="status-separator">/</span>CPU render submission{" "}
          {renderMs.toFixed(1)} ms<span className="status-separator">/</span>
          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(false);
              setHelp(true);
            }}
          >
            Keyboard shortcuts <kbd>?</kbd>
          </button>
        </span>
      </footer>
      {profilesOpen && source && (
        <ProfilePlots
          key={sourceId}
          source={source}
          reader={registry.current.get(sourceId)!}
          frame={frame}
          theme={theme}
          onClose={() => setProfilesOpen(false)}
          onPick={(uid, particleIndex) => {
            setSelection({
              sourceId,
              frame: displayedIndex,
              index: particleIndex,
              uid: uid ?? undefined,
            });
            setTraceUid(uid ?? "");
            if (uid) materialPick.current(uid, displayedIndex, sourceId);
          }}
        />
      )}
      {videoOpen && (
        <div className="modal-backdrop">
          <section
            className="settings-modal modal"
            role="dialog"
            aria-modal="true"
            aria-label="Export viewport video"
          >
            <div className="modal-heading">
              <h2>Export viewport video</h2>
              <button
                className="icon-button"
                aria-label="Close video settings"
                onClick={() => setVideoOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              Capture the scene, title, time, particle count, color bar and
              axes. Controls stay outside the video.
            </p>
            <label>
              Video frames per second
              <NumberControl
                min={1}
                max={120}
                step={1}
                value={videoFPS}
                onValueChange={setVideoFPS}
              />
            </label>
            {source?.live ? (
              <>
                <label>
                  Capture cadence
                  <select
                    aria-label="Video capture cadence"
                    value={videoMode}
                    onChange={(e) =>
                      setVideoMode(e.target.value as "time" | "steps")
                    }
                  >
                    <option value="time">Simulation time</option>
                    <option
                      value="steps"
                      disabled={!simulationControl?.canStepVideo}
                    >
                      Every N simulation steps
                    </option>
                  </select>
                </label>
                <label>
                  {videoMode === "steps"
                    ? "Simulation steps between frames"
                    : "Simulation time between frames"}
                  <NumberControl
                    min={videoMode === "steps" ? 1 : 0.000001}
                    step={videoMode === "steps" ? 1 : 0.01}
                    value={
                      videoMode === "steps" ? videoEverySteps : videoInterval
                    }
                    onValueChange={
                      videoMode === "steps"
                        ? setVideoEverySteps
                        : setVideoInterval
                    }
                  />
                </label>
                <p>
                  The solver waits at completed steps until each requested frame
                  is rendered and encoded. Without a recorded trajectory, losing
                  the viewer holds the simulation until you reconnect and resume
                  capture or release the hold.
                </p>
              </>
            ) : (
              <div className="video-range">
                <label>
                  First frame
                  <NumberControl
                    min={0}
                    max={videoEnd}
                    step={1}
                    value={videoStart}
                    onValueChange={setVideoStart}
                  />
                </label>
                <label>
                  Last frame
                  <NumberControl
                    min={videoStart}
                    max={(source?.frames ?? 1) - 1}
                    step={1}
                    value={videoEnd}
                    onValueChange={setVideoEnd}
                  />
                </label>
                <label>
                  Frame stride
                  <NumberControl
                    min={1}
                    step={1}
                    value={videoStride}
                    onValueChange={setVideoStride}
                  />
                </label>
              </div>
            )}
            <p className="capture-estimate" role="status">
              {videoPlanText(plannedVideo)} at {videoFPS} fps. Includes the
              first and final frame.
            </p>
            {source?.live && (
              <p className="subtle-note">
                Time-based counts are estimates: capture occurs at completed
                simulation steps and Δt may vary. For exact step counts, use a
                step-limited run. Final off-cadence frames are included.
              </p>
            )}
            {recordingView?.sourceId === sourceId && (
              <button onClick={restoreRecordingPreset}>
                Restore recording view
              </button>
            )}
            <p className="subtle-note">
              WebM / VP8. Encoded video is held in browser memory until saved.
              Keep this tab open; background tabs may capture more slowly.
            </p>
            {videoError && <p role="alert">{videoError}</p>}
            <button
              className="primary-button"
              disabled={
                (!!source?.live && !simulationControl?.setVideo) ||
                !validCadence(
                  videoFPS,
                  videoInterval,
                  videoMode === "steps" ? videoEverySteps : undefined,
                ) ||
                loading ||
                presentation?.key !== presentationKey
              }
              onClick={() =>
                source?.videoArmed
                  ? void playPreparedVideo()
                  : void startVideo()
              }
            >
              {source?.videoArmed
                ? "Start video and simulation"
                : "Start video export"}
            </button>
          </section>
        </div>
      )}
      {configurationView && (
        <div
          className="modal-backdrop"
          onClick={() => setConfigurationView(null)}
        >
          <section
            className="modal configuration-inspector"
            role="dialog"
            aria-modal="true"
            aria-label="Simulation configuration"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>Simulation configuration</h2>
              <button
                className="icon-button"
                aria-label="Close simulation configuration"
                onClick={() => setConfigurationView(null)}
              >
                <X size={18} />
              </button>
            </header>
            <p className="subtle-note">
              Read-only resolved setup. Current adaptive Δt is shown in the live
              metrics.
            </p>
            {configurationView.loading ? (
              <p>Loading configuration…</p>
            ) : configurationView.error ? (
              <p role="alert">{configurationView.error}</p>
            ) : (
              <pre>{JSON.stringify(configurationView.data, null, 2)}</pre>
            )}
          </section>
        </div>
      )}
      <CompanionPanel
        section={companionSection}
        onConnection={setDaemonConnected}
        open={companionOpen}
        onControl={setLiveControl}
        prepareVideo={async (fps) => {
          if (videoSession.current)
            throw new Error(
              "Finish the current video before launching another capture.",
            );
          if (!engine.current)
            throw new Error("The viewport is still initializing.");
          const { width, height } = videoDimensions(
            engine.current.captureCanvas(),
          );
          if (!(await ViewportVideo.supported(width, height, fps)))
            throw new Error(
              "VP8 video encoding is unavailable in this browser. Use a browser with WebCodecs VideoEncoder support.",
            );
        }}
        onOpen={() => {
          setCompanionSection("running");
          setCompanionOpen(true);
        }}
        onClose={() => setCompanionOpen(false)}
        sourceId={sourceId}
        onFrame={(reader, first) => {
          const metadata = reader.metadata;
          if (first) {
            registry.current.get(metadata.id)?.close();
            registry.current.set(metadata.id, reader);
          }
          setSources((old) => [
            ...old.filter((s) => s.id !== metadata.id),
            metadata,
          ]);
          if (first) {
            if (sourceId !== metadata.id) chooseSource(metadata);
            else if (metadata.initialFrame !== undefined)
              seek(metadata.initialFrame);
          } else if (first) {
            // A recovered run can reuse its ID and restart its snapshot sequence.
            setPresentation(null);
            setRetryRevision((value) => value + 1);
          }
        }}
        onDetached={(id) =>
          setSources((old) =>
            old.map((s) =>
              s.id === id
                ? {
                    ...s,
                    liveConnected: false,
                    format: "Detached live snapshot",
                  }
                : s,
            ),
          )
        }
      />
      {open && (
        <TrajectoryPicker
          sources={sources}
          active={sourceId}
          cached={cachedDemos}
          saved={savedInfo}
          tab={pickerTab}
          onTab={setPickerTab}
          onSource={(s) => {
            chooseSource(s);
            setOpen(false);
          }}
          onDemo={(demo) => void openRecordedDemo(demo)}
          onSaved={() =>
            void (async () => {
              try {
                const saved = await recallFiles();
                if (!saved) {
                  setSavedInfo(null);
                  return;
                }
                const entry = [...localFiles.current].find(
                  ([, files]) => fileKey(files) === saved.key,
                );
                const existing = entry && registry.current.get(entry[0]);
                if (existing) {
                  chooseSource(existing.metadata);
                  setOpen(false);
                } else await openFiles(saved.files);
              } catch (e) {
                setOpenError(e instanceof Error ? e.message : String(e));
              }
            })()
          }
          onClose={() => setOpen(false)}
          busy={opening}
          download={demoDownload}
          onCancelDownload={cancelDemo}
          error={demoError || (pickerTab !== "file" ? openError : "")}
          storageError={demoCacheError}
        >
          <button
            type="button"
            className="file-picker-zone"
            disabled={opening}
            onClick={() => fileInput.current?.click()}
          >
            {opening ? (
              <LoaderCircle className="spin" size={28} />
            ) : (
              <FolderOpen size={28} />
            )}
            <strong>
              {opening ? "Reading recording…" : "Choose a trajectory file"}
            </strong>
            <span>or drop it anywhere on the page</span>
          </button>
          <div className="format-hints">
            <span>HDF5 · .h5 / .hdf5</span>
            <span>NPZ · multiple snapshots</span>
          </div>
          <button
            className="text-button folder-button"
            disabled={opening}
            onClick={() => folderInput.current?.click()}
          >
            Select a folder of NPZ snapshots
          </button>
          {openError && (
            <div className="form-error" role="alert">
              {openError}
            </div>
          )}
          {serviceMode && (
            <details className="service-details">
              <summary>Open a path through this local service</summary>
              <form onSubmit={openSource}>
                <input
                  ref={initialFocus}
                  id="path"
                  aria-label="Local file or directory path"
                  className="path-input"
                  placeholder="/path/to/trajectory.h5"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  required
                />
                <button
                  className="primary-button"
                  type="submit"
                  disabled={opening || !path.trim()}
                >
                  Open server path
                </button>
              </form>
            </details>
          )}
        </TrajectoryPicker>
      )}
      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="modal-heading">
              <span className="modal-icon">
                <Settings2 size={22} />
              </span>
              <IconButton
                label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <h2 id="settings-title">Viewer settings</h2>
            <p>Preferences for this device. Your recordings stay local.</p>
            <label className="control-label" htmlFor="viewer-theme">
              Theme
            </label>
            <select
              id="viewer-theme"
              value={theme}
              onChange={(e) => {
                const next = e.target.value as "dark" | "light";
                setTheme(next);
                setOption("background", next);
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
            <label className="control-label" htmlFor="compute-backend">
              Compute backend
            </label>
            <select
              id="compute-backend"
              value={fieldView.settings.backend ?? "auto"}
              onChange={(e) =>
                fieldView.setSettings((old) => ({
                  ...old,
                  backend: e.target.value as "auto" | "webgpu" | "cpu",
                }))
              }
            >
              <option value="auto">Auto · prefer WebGPU</option>
              <option value="webgpu">WebGPU</option>
              <option value="cpu">CPU reference</option>
            </select>
            <p className="subtle-note">
              Auto falls back to CPU when WebGPU is unavailable. The active
              backend appears below Field view.
            </p>
            <div className="label-row">
              <span>Wrap periodic coordinates</span>
              <Toggle
                label="Wrap periodic coordinates"
                value={options.wrapPeriodic}
                onChange={(v) => setOption("wrapPeriodic", v)}
              />
            </div>
            <p className="subtle-note">
              Uses periodic domain metadata. Original recording coordinates and
              material traces are preserved.
            </p>
            <div className="label-row background-row">
              <span>Scene background</span>
              <div className="segmented">
                <button
                  className={options.background === "dark" ? "selected" : ""}
                  onClick={() => setOption("background", "dark")}
                >
                  Dark
                </button>
                <button
                  className={options.background === "light" ? "selected" : ""}
                  onClick={() => setOption("background", "light")}
                >
                  Light
                </button>
              </div>
            </div>
            <label className="remember-choice">
              <input
                type="checkbox"
                aria-label="Remember last recording"
                checked={remember}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  rememberRef.current = enabled;
                  setRemember(enabled);
                  setRememberEnabled(enabled);
                  if (!enabled) void forgetRecording();
                  else {
                    const files = localFiles.current.get(sourceId);
                    if (files) persistFiles(files);
                  }
                }}
              />
              Remember last recording on this device
            </label>
            <p className="subtle-note">
              Stores one browser-local copy and visualization settings for
              refresh. Reopen the original to read changes. Browser storage
              limits apply.
            </p>
            <p className="subtle-note">
              Downloaded demos are saved separately on this device. This
              checkbox controls reopening the last recording automatically.
            </p>
            {storageStatus && (
              <p className="subtle-note" role="status">
                {storageStatus}
              </p>
            )}
            <button
              className="text-button folder-button"
              onClick={() => void forgetRecording()}
            >
              Forget saved recording
            </button>

            <div className="modal-actions">
              <button
                className="primary-button"
                onClick={() => setSettingsOpen(false)}
              >
                Done
              </button>
            </div>
          </section>
        </div>
      )}
      {ftleOpen && source && registry.current.get(sourceId) && (
        <FTLEMap
          key={sourceId}
          source={source}
          reader={registry.current.get(sourceId)!}
          seedIndex={displayedIndex}
          endIndex={displayedIndex}
          radius={material.settings.radius}
          neighbours={material.settings.count}
          onClose={() => setFTLEOpen(false)}
          onPick={(uid, index) => {
            seek(index);
            setSelection({ sourceId, frame: index, index: -1, uid });
            setTraceUid(uid);
            materialPick.current(uid, index, sourceId);
          }}
        />
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modal-heading">
              <span className="modal-icon">
                <Info size={22} />
              </span>
              <IconButton label="Close help" onClick={() => setHelp(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <h2 id="help-title">A closer look at your simulation.</h2>
            <p>
              Recorded arrays are rendered in your browser. Changing the camera
              or colors never calls a simulator.
            </p>
            <dl className="shortcut-list">
              <dt>Play / pause</dt>
              <dd>
                <kbd>Space</kbd>
              </dd>
              <dt>Previous / next frame</dt>
              <dd>
                <kbd>←</kbd> <kbd>→</kbd>
              </dd>
              <dt>Fit current frame</dt>
              <dd>
                <kbd>F</kbd>
              </dd>
              <dt>Pan · 2D</dt>
              <dd>Left drag</dd>
              <dt>Orbit · 3D</dt>
              <dd>Left drag</dd>
              <dt>Pan · 3D</dt>
              <dd>Right drag</dd>
              <dt>Zoom</dt>
              <dd>Scroll</dd>
              <dt>Pick particle tool</dt>
              <dd>
                <kbd>P</kbd>, then click
              </dd>
              <dt>Clear particle selection</dt>
              <dd>
                <kbd>Esc</kbd>
              </dd>
            </dl>
            <p className="subtle-note">
              Logarithmic views show nonpositive or invalid values in gray.
              Boundaries and ghosts are passive gray. Color limits use fluid
              particles. Units follow the recording; no unit conversions are
              applied. The reference box shows the first frame's particle
              bounds.
            </p>
            <p className="subtle-note">
              HDF5 decoding uses h5wasm, developed by the National Institute of
              Standards and Technology.{" "}
              <a
                href={`${import.meta.env.BASE_URL}licenses/h5wasm.txt`}
                target="_blank"
                rel="noreferrer"
              >
                h5wasm / HDF5 notices
              </a>{" "}
              ·{" "}
              <a
                href={`${import.meta.env.BASE_URL}licenses/fflate.txt`}
                target="_blank"
                rel="noreferrer"
              >
                fflate license
              </a>
            </p>
            <button className="primary-button" onClick={() => setHelp(false)}>
              <Check size={15} />
              Got it
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
