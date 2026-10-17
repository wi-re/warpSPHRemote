import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  Box,
  Check,
  FolderOpen,
  Layers,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  recordedDemos,
  demoSize,
  type RecordedDemo,
  type DemoStage,
} from "./recordedDemos";
import type { Source } from "./types";
export type PickerTab = "examples" | "demos" | "saved" | "file";
const tabs: [PickerTab, string][] = [
  ["examples", "Example recordings"],
  ["demos", "Analytical demos"],
  ["saved", "On this device"],
  ["file", "Open file"],
];
export interface SavedRecordingInfo {
  name: string;
  bytes: number;
  key: string;
}
export function TrajectoryPicker({
  sources,
  active,
  cached,
  saved,
  tab,
  onTab,
  onSource,
  onDemo,
  onSaved,
  onClose,
  busy,
  download,
  onCancelDownload,
  error,
  storageError,
  children,
}: {
  sources: Source[];
  active: string;
  cached: Set<string>;
  saved: SavedRecordingInfo | null;
  tab: PickerTab;
  onTab: (tab: PickerTab) => void;
  onSource: (source: Source) => void;
  onDemo: (demo: RecordedDemo) => void;
  onSaved: () => void;
  onClose: () => void;
  busy: boolean;
  download: { id: string; stage: DemoStage; received: number } | null;
  onCancelDownload: () => void;
  error: string;
  storageError: string;
  children: ReactNode;
}) {
  const sourceCard = (s: Source) => (
    <button
      key={s.id}
      className={`picker-card ${s.id === active ? "selected" : ""}`}
      aria-label={`Open source: ${s.name}`}
      onClick={() => onSource(s)}
      disabled={busy}
    >
      {s.dimension === 3 ? <Box size={22} /> : <Layers size={22} />}
      <span>
        <strong>{s.name}</strong>
        <small>
          {s.dimension}D · {s.frames} frames
          {active === s.id ? " · Current trajectory" : ""}
        </small>
      </span>
      {active === s.id && <Check size={16} />}
    </button>
  );
  const exampleCard = (d: RecordedDemo) => (
    <div key={d.id}>
      <button
        className={`picker-card ${active === d.id ? "selected" : ""}`}
        onClick={() => onDemo(d)}
        disabled={busy || download?.id === d.id}
        aria-label={`${cached.has(d.id) ? "Open saved demo" : "Load demo"}: ${d.name}`}
      >
        {download?.id === d.id ? (
          <LoaderCircle size={22} className="spin" />
        ) : cached.has(d.id) ? (
          <FolderOpen size={22} />
        ) : (
          <ArrowDownToLine size={22} />
        )}
        <span>
          <strong>{d.name}</strong>
          <small>
            {d.particles.toLocaleString()} particles · {d.frames} frames ·{" "}
            {demoSize(d.bytes)}
          </small>
          <em>
            {cached.has(d.id)
              ? "Saved on this device"
              : "Download once · then available locally"}
          </em>
        </span>
        {active === d.id && <Check size={16} />}
      </button>
      <p className="picker-description">{d.description}</p>
      {download?.id === d.id && (
        <div className="demo-download" role="status">
          {download.stage === "downloading" && (
            <progress
              aria-label={`Downloading ${d.name}`}
              max={d.bytes}
              value={download.received}
            />
          )}
          <span>
            {download.stage === "checking"
              ? "Checking saved download…"
              : download.stage === "saving"
                ? "Saving on this device…"
                : download.stage === "opening"
                  ? "Opening recording…"
                  : `${Math.round((100 * download.received) / d.bytes)}% downloaded`}
          </span>
          <button className="text-button" onClick={onCancelDownload}>
            Cancel loading demo
          </button>
        </div>
      )}
    </div>
  );
  const local = sources.filter(
    (s) => s.format !== "Analytical demo" && s.format !== "Recorded demo",
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal trajectory-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-title"
      >
        <div className="modal-heading">
          <span className="modal-icon">
            <FolderOpen size={22} />
          </span>
          <button
            className="icon-button"
            aria-label="Close open dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="open-title">Open a trajectory</h2>
        <p>
          Explore an example or open a recording. Files are read on your device.
        </p>
        <div
          className="picker-tabs"
          role="tablist"
          aria-label="Trajectory location"
        >
          {tabs.map(([id, label], i) => (
            <button
              role="tab"
              key={id}
              id={`picker-tab-${id}`}
              aria-controls={`picker-panel-${id}`}
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => onTab(id)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight"
                    ? (i + 1) % tabs.length
                    : e.key === "ArrowLeft"
                      ? (i + tabs.length - 1) % tabs.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : -1;
                if (next >= 0) {
                  e.preventDefault();
                  onTab(tabs[next][0]);
                  document
                    .getElementById(`picker-tab-${tabs[next][0]}`)
                    ?.focus();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="picker-panel"
          role="tabpanel"
          id={`picker-panel-${tab}`}
          aria-labelledby={`picker-tab-${tab}`}
        >
          {tab === "examples" && (
            <>
              <p className="subtle-note">
                Recorded solver runs. Downloads are cached independently of your
                last local file.
              </p>
              <div className="picker-cards">
                {recordedDemos.map(exampleCard)}
              </div>
            </>
          )}
          {tab === "demos" && (
            <>
              <p className="subtle-note">
                Sampled analytical fields · no download required. These are not
                advected solver trajectories.
              </p>
              <div className="picker-cards">
                {sources
                  .filter((s) => s.format === "Analytical demo")
                  .map(sourceCard)}
              </div>
            </>
          )}
          {tab === "saved" && (
            <>
              {saved && (
                <>
                  <div className="section-heading">LAST LOCAL RECORDING</div>
                  <button
                    className="picker-card"
                    onClick={onSaved}
                    disabled={busy}
                    aria-label="Open remembered recording"
                  >
                    <FolderOpen size={22} />
                    <span>
                      <strong>{saved.name}</strong>
                      <small>
                        {demoSize(saved.bytes)} · Browser-local copy
                      </small>
                    </span>
                  </button>
                </>
              )}
              {local.length > 0 && (
                <>
                  <div className="section-heading">OPEN IN THIS SESSION</div>
                  {local.map(sourceCard)}
                </>
              )}
              {[...cached].length > 0 && (
                <>
                  <div className="section-heading">SAVED EXAMPLES</div>
                  <div className="picker-cards">
                    {recordedDemos
                      .filter((d) => cached.has(d.id))
                      .map(exampleCard)}
                  </div>
                </>
              )}
              {!saved && !local.length && !cached.size && (
                <div className="picker-empty">
                  <FolderOpen size={30} />
                  <strong>No saved recordings yet</strong>
                  <p>
                    Open a file or download an example to keep a copy on this
                    device.
                  </p>
                </div>
              )}
              <p className="subtle-note">
                Local copies belong to this browser and site. Retention
                preferences are in Viewer settings.
              </p>
            </>
          )}
          {tab === "file" && children}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {storageError && (
            <p className="subtle-note" role="status">
              {storageError}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
