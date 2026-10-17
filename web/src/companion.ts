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
  image: string;
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
}
export interface Snapshot {
  frame: Frame;
  metadata: Source;
  sequence: number;
}

export function companionEndpoint(input: string): string {
  const url = new URL(input);
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
  async request(path: string, data?: object, signal?: AbortSignal) {
    const init: RequestInit & { targetAddressSpace?: string } = {
      method: data ? "POST" : "GET",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
      cache: "no-store",
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
      throw new Error(
        (await response.json().catch(() => ({}))).error ||
          `Companion returned HTTP ${response.status}.`,
      );
    return response;
  }
  async session(
    signal?: AbortSignal,
  ): Promise<{ version: number; presets: Preset[] }> {
    const value = await (
      await this.request("/v1/session", undefined, signal)
    ).json();
    if (value.version !== 1)
      throw new Error("This companion uses an unsupported protocol version.");
    return value;
  }
  async runs(signal?: AbortSignal): Promise<Simulation[]> {
    return (await (await this.request("/v1/runs", undefined, signal)).json())
      .runs;
  }
  async launch(spec: object) {
    return (await (await this.request("/v1/runs", spec)).json()) as Simulation;
  }
  async attach(id: string) {
    this.statics = undefined;
    await this.request(`/v1/runs/${id}/attach`, {});
  }
  async detach(id: string) {
    await this.request(`/v1/runs/${id}/detach`, {});
    this.statics = undefined;
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
