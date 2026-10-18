import { decodeFrame } from "./data";
import { ServiceSource } from "./sources/client";
import { reduceDiagnostic } from "./sources/core";
import type { Frame, Source } from "./types";

export interface Preset {
  id: string;
  name: string;
  description: string;
  schemes: string[];
  nx: number;
  duration: number;
  maxNx?: number;
  variants: Record<string, object>;
  image: string | null;
  family?: string;
  available?: boolean;
  unavailableReason?: string;
  configurable?: boolean;
  nativeVariants?: boolean;
}
export interface Simulation {
  id: string;
  name: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  pid?: number;
  step?: number;
  time?: number;
  dt?: number;
  particles?: number;
  scheme?: string;
  visualized: boolean;
  stale: boolean;
  registered?: boolean;
  sequence: number;
  createdBy: string;
  message?: string;
  pauseRequested?: boolean;
  recording?: { enabled: boolean; mode: string };
}
/** Keep capture failures visible while the producer retries and controls remain available. */
export function liveConnectionStatus(run: Simulation): string {
  if (run.message) return run.message;
  if (run.stale) return "waiting for a producer heartbeat…";
  return run.status === "running" || run.status === "paused"
    ? "waiting for the first live frame…"
    : "waiting for startup…";
}
export interface SimulationControl {
  sourceId: string;
  status: string;
  pauseRequested: boolean;
  canPause: boolean;
  busy: boolean;
  toggle: () => void;
}
export function canPauseSimulation(
  run: Simulation | undefined,
  features: string[],
) {
  return (
    !!run?.registered &&
    features.includes("pause") &&
    ["running", "starting", "paused"].includes(run.status)
  );
}
export interface Snapshot {
  frame: Frame;
  metadata: Source;
  sequence: number;
}

export function companionEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "Enter a valid HTTP(S) address and port, such as http://127.0.0.1:8766.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter an HTTP(S) address and port, without a path or credentials.",
    );
  return url.origin;
}
/** Pairing handoff secrets live in the fragment, then only in memory. */
export function takePairing(
  location: Pick<Location, "hash" | "pathname" | "search">,
  replace: (url: string) => void,
) {
  const values = new URLSearchParams(location.hash.slice(1));
  if (!values.has("companion") || !values.has("pair")) return null;
  const value = {
    endpoint: values.get("companion")!,
    token: values.get("pair")!,
  };
  replace(location.pathname + location.search);
  return value;
}
// Initial pairing may wait for a browser permission decision; ordinary API calls stay bounded.
export const companionRequestTimeout = 10_000;
export const companionPairingTimeout = 60_000;
export class CompanionHTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CompanionHTTPError";
  }
}
export function companionConnectionMessage(error: unknown): string {
  if (error instanceof CompanionHTTPError) {
    if (error.status === 401)
      return "The companion rejected the pairing token. Copy the current token from its terminal and try again.";
    return error.message;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError")
      return "Connection timed out while waiting for the companion or browser permission. If you just clicked Allow, press Connect again. Check that the companion or SSH tunnel is running.";
    if (error.name === "TypeError" || error.name === "NetworkError")
      return "The browser could not reach the companion. Check the address and SSH tunnel, then the browser Web Console for blocked local-network, mixed-content or CORS requests.";
    return error.message;
  }
  return "Could not connect to the companion.";
}
export class CompanionClient {
  readonly endpoint: string;
  readonly viewer = crypto.randomUUID();
  private statics?: { revision: string; frame: Frame };
  constructor(
    endpoint: string,
    private token: string,
  ) {
    this.endpoint = companionEndpoint(endpoint);
  }
  async request(
    path: string,
    data?: object,
    signal?: AbortSignal,
    timeoutMs = companionRequestTimeout,
    keepalive = false,
  ) {
    const init: RequestInit & { targetAddressSpace?: string } = {
      method: data ? "POST" : "GET",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      keepalive,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Viewer-Id": this.viewer,
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      targetAddressSpace: ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(this.endpoint).hostname,
      )
        ? "loopback"
        : "local",
    };
    const response = await fetch(this.endpoint + path, init);
    if (!response.ok)
      throw new CompanionHTTPError(
        response.status,
        (await response.json().catch(() => ({}))).error ||
          `Companion returned HTTP ${response.status}.`,
      );
    return response;
  }
  async session(
    signal?: AbortSignal,
    refresh = false,
  ): Promise<{ version: number; presets: Preset[]; features?: string[] }> {
    const value = await (
      await this.request(
        refresh ? "/v1/session?refresh=1" : "/v1/session",
        undefined,
        signal,
        companionPairingTimeout,
      )
    ).json();
    if (value.version !== 1)
      throw new Error("This companion uses an unsupported protocol version.");
    return value;
  }
  async runs(signal?: AbortSignal): Promise<Simulation[]> {
    return (await (await this.request("/v1/runs", undefined, signal)).json())
      .runs;
  }
  async configuration(preset: string, scheme: string, signal?: AbortSignal) {
    return (
      await this.request(
        `/v1/configuration?preset=${encodeURIComponent(preset)}&scheme=${encodeURIComponent(scheme)}`,
        undefined,
        signal,
        65000,
      )
    ).json();
  }
  async launch(spec: object) {
    return (await (
      await this.request("/v1/runs", spec, undefined, 65000)
    ).json()) as Simulation;
  }
  async attach(id: string) {
    this.statics = undefined;
    await this.request(`/v1/runs/${id}/attach`, {});
  }
  async detach(id: string, keepalive = false) {
    await this.request(
      `/v1/runs/${id}/detach`,
      {},
      undefined,
      companionRequestTimeout,
      keepalive,
    );
    this.statics = undefined;
  }
  async pause(id: string, paused: boolean) {
    await this.request(`/v1/runs/${id}/${paused ? "pause" : "resume"}`, {});
  }
  private historyQueue: Promise<unknown> = Promise.resolve();
  private historyRequest<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.historyQueue.then(operation, operation);
    this.historyQueue = result.catch(() => {});
    return result;
  }
  async recording(id: string, signal?: AbortSignal): Promise<Source> {
    return this.historyRequest(async () => {
      signal?.throwIfAborted();
      const info = await (
        await this.request(`/v1/runs/${id}/history`, undefined, signal)
      ).json();
      return {
        ...info,
        id: `history-${id}`,
        name: `${info.name} · recorded history`,
      };
    });
  }
  async recordedFrame(
    id: string,
    index: number,
    field: string,
    signal?: AbortSignal,
  ) {
    return this.historyRequest(async () => {
      signal?.throwIfAborted();
      const r = await this.request(
        `/v1/runs/${id}/history/frame?index=${index}&field=${encodeURIComponent(field)}`,
        undefined,
        signal,
      );
      return decodeFrame(await r.arrayBuffer());
    });
  }
  async stop(id: string) {
    await this.request(`/v1/runs/${id}/stop`, {});
  }
  async ack(id: string, sequence: number) {
    await this.request(`/v1/runs/${id}/ack`, { sequence });
  }
  async snapshot(id: string, signal?: AbortSignal): Promise<Snapshot | null> {
    const r = await this.request(`/v1/runs/${id}/snapshot`, undefined, signal);
    if (r.status === 204) return null;
    const revision = r.headers.get("X-Static-Revision"),
      sequence = Number(r.headers.get("X-Snapshot-Sequence"));
    if (!revision || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("Incomplete live snapshot headers.");
    const info = JSON.parse(r.headers.get("X-Snapshot-Metadata") || "null");
    if (
      !info ||
      ![2, 3].includes(info.dimension) ||
      !Array.isArray(info.fields)
    )
      throw new Error("Invalid live metadata.");
    const dynamic = decodeFrame(await r.arrayBuffer());
    if (this.statics?.revision !== revision) {
      const s = await this.request(`/v1/runs/${id}/static`, undefined, signal);
      if (s.status === 204)
        throw new Error(
          "The simulation has not provided its static particle data.",
        );
      this.statics = {
        revision,
        frame: decodeFrame(await s.arrayBuffer(), true),
      };
    }
    const arrays = { ...this.statics.frame.arrays, ...dynamic.arrays },
      n = arrays.positions.shape[0];
    for (const [name, a] of Object.entries(arrays))
      if (a.shape[0] !== n)
        throw new Error(`Live field ${name} has a different particle count.`);
    if (!arrays.UIDs || !arrays.kinds)
      throw new Error("Live particle identities are missing.");
    return {
      sequence,
      frame: {
        ...dynamic,
        index: 0,
        step: info.step,
        liveRevision: sequence,
        arrays,
        bytes: dynamic.bytes + this.statics.frame.bytes,
      },
      metadata: {
        ...info,
        id: `live-${id}`,
        format: "Live simulation",
        frames: 1,
        times: [dynamic.time],
        timeKind: "simulation",
        live: true,
        liveConnected: true,
        liveRevision: sequence,
        liveStep: info.step,
      },
    };
  }
}

/** Reuses renderer/compute contracts; only acquisition differs from a recording. */
export class LiveSource extends ServiceSource {
  private current: Frame;
  private acknowledged = false;
  private acknowledge: () => Promise<void>;
  constructor(snapshot: Snapshot, acknowledge: () => Promise<void>) {
    super(snapshot.metadata);
    this.current = snapshot.frame;
    this.acknowledge = acknowledge;
  }
  update(snapshot: Snapshot, acknowledge: () => Promise<void>) {
    this.metadata = snapshot.metadata;
    this.current = snapshot.frame;
    this.acknowledge = acknowledge;
    this.acknowledged = false;
  }
  async frame(_index: number, field: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.current.arrays[field])
      throw new Error(`Live field ${field} is unavailable.`);
    return this.current;
  }
  async diagnostics() {
    return [reduceDiagnostic(this.current.arrays, 0, this.current.time)];
  }
  async displayed(revision?: number) {
    if (revision !== this.metadata.liveRevision || this.acknowledged) return;
    this.acknowledged = true;
    try {
      await this.acknowledge();
    } catch (error) {
      this.acknowledged = false;
      throw error;
    }
  }
}

/** Existing disk exports, with a growing frame index and bounded browser cache. */
export class RecordedSource extends ServiceSource {
  private cache = new Map<string, Frame>();
  private bytes = 0;
  constructor(
    metadata: Source,
    private client: CompanionClient,
    readonly runId: string,
  ) {
    super(metadata);
  }
  async refresh(signal?: AbortSignal) {
    const next = await this.client.recording(this.runId, signal);
    if (
      next.frames === this.metadata.frames &&
      next.times.at(-1) === this.metadata.times.at(-1)
    )
      return false;
    this.metadata = next;
    return true;
  }
  async frame(index: number, field: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const key = `${index}:${field}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const frame = await this.client.recordedFrame(
      this.runId,
      index,
      field,
      signal,
    );
    // A single very large frame is returned without retaining it.
    if (frame.bytes <= 64 * 1024 * 1024) {
      while (
        this.cache.size &&
        (this.cache.size >= 8 || this.bytes + frame.bytes > 64 * 1024 * 1024)
      ) {
        const oldest = this.cache.keys().next().value!;
        this.bytes -= this.cache.get(oldest)!.bytes;
        this.cache.delete(oldest);
      }
      this.cache.set(key, frame);
      this.bytes += frame.bytes;
    }
    return frame;
  }
  async diagnostics(start: number, count: number, signal?: AbortSignal) {
    const rows = [];
    for (
      let i = start;
      i < Math.min(start + count, this.metadata.frames);
      i++
    ) {
      const frame = await this.frame(i, "velocities", signal);
      const arrays = { ...frame.arrays };
      if (this.metadata.internalEnergyAvailable)
        arrays.internalEnergies = (
          await this.frame(i, "internalEnergies", signal)
        ).arrays.internalEnergies;
      rows.push(reduceDiagnostic(arrays, i, this.metadata.times[i]));
    }
    return rows;
  }
  close() {
    this.cache.clear();
    this.bytes = 0;
    super.close();
  }
}
