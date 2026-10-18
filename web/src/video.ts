import { palettes } from "./palettes";

const bytes = (n: number) => {
  const a: number[] = [];
  do {
    a.unshift(n % 256);
    n = Math.floor(n / 256);
  } while (n);
  return new Uint8Array(a);
};
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const size = (n: number) => {
  for (let len = 1; len <= 8; len++)
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let rest = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = rest % 256;
        rest = Math.floor(rest / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  throw new Error("Video exceeds WebM size range.");
};
const el = (id: number, ...data: Uint8Array[]) => {
  const value = join(data);
  return join([bytes(id), size(value.length), value]);
};
const uint = (id: number, n: number) => el(id, bytes(n));
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
const float = (id: number, n: number) => {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setFloat64(0, n);
  return el(id, a);
};
export interface VideoChunk {
  data: Uint8Array;
  timestamp: number;
  key: boolean;
}
/** Minimal single-video-track WebM: explicit duration, keyframe cues and no audio. */
export function webm(
  chunks: VideoChunk[],
  width: number,
  height: number,
  fps: number,
): Uint8Array {
  if (!chunks.length) throw new Error("No video frames have been captured.");
  const header = el(
    0x1a45dfa3,
    uint(0x4286, 1),
    uint(0x42f7, 1),
    uint(0x42f2, 4),
    uint(0x42f3, 8),
    str(0x4282, "webm"),
    uint(0x4287, 4),
    uint(0x4285, 2),
  );
  const info = el(
    0x1549a966,
    uint(0x2ad7b1, 1000000),
    str(0x4d80, "warpSPHRemote"),
    str(0x5741, "warpSPHRemote"),
    float(0x4489, (chunks.length * 1000) / fps),
  );
  const tracks = el(
    0x1654ae6b,
    el(
      0xae,
      uint(0xd7, 1),
      uint(0x73c5, 1),
      uint(0x83, 1),
      uint(0x23e383, Math.round(1e9 / fps)),
      str(0x86, "V_VP8"),
      el(0xe0, uint(0xb0, width), uint(0xba, height)),
    ),
  );
  let offset = info.length + tracks.length;
  const cues: Uint8Array[] = [];
  const clusters = chunks.map((chunk) => {
    const time = Math.round(chunk.timestamp / 1000);
    if (chunk.key)
      cues.push(
        el(0xbb, uint(0xb3, time), el(0xb7, uint(0xf7, 1), uint(0xf1, offset))),
      );
    const cluster = el(
      0x1f43b675,
      uint(0xe7, time),
      el(0xa3, new Uint8Array([0x81, 0, 0, chunk.key ? 0x80 : 0]), chunk.data),
    );
    offset += cluster.length;
    return cluster;
  });
  return join([
    header,
    (() => {
      const cueData = join(cues),
        cue = join([bytes(0x1c53bb6b), size(cueData.length), cueData]);
      const data = join([info, tracks, ...clusters, cue]);
      return join([bytes(0x18538067), size(data.length), data]);
    })(),
  ]);
}
export class ViewportVideo {
  private encoder: VideoEncoder;
  private chunks: VideoChunk[] = [];
  private error?: Error;
  frames = 0;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.chunks.push({
          data,
          timestamp: chunk.timestamp,
          key: chunk.type === "key",
        });
      },
      error: (error) => {
        this.error = error;
      },
    });
    this.encoder.configure({
      codec: "vp8",
      width,
      height,
      framerate: fps,
      bitrate: 8_000_000,
      latencyMode: "realtime",
    });
  }
  static async supported(width: number, height: number, fps: number) {
    return (
      typeof VideoEncoder !== "undefined" &&
      (
        await VideoEncoder.isConfigSupported({
          codec: "vp8",
          width,
          height,
          framerate: fps,
          bitrate: 8_000_000,
        })
      ).supported
    );
  }
  async add(canvas: HTMLCanvasElement) {
    if (this.error) throw this.error;
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((this.frames * 1e6) / this.fps),
      duration: Math.round(1e6 / this.fps),
    });
    try {
      this.encoder.encode(frame, {
        keyFrame: this.frames % Math.max(1, Math.round(this.fps * 2)) === 0,
      });
      this.frames++;
    } finally {
      frame.close();
    }
    // At most one rendered frame in flight; ACK follows actual encoder output.
    await this.encoder.flush();
    if (this.error) throw this.error;
  }
  finish() {
    this.encoder.close();
    const result = webm(this.chunks, this.width, this.height, this.fps);
    this.chunks = [];
    return new Blob([result as Uint8Array<ArrayBuffer>], {
      type: "video/webm",
    });
  }
  dispose() {
    if (this.encoder.state !== "closed") this.encoder.close();
    this.chunks = [];
  }
}
export interface CaptureLabels {
  title: string;
  quantity: string;
  details: string;
  particles: number;
  palette: string;
  range: [number, number];
  axes: number[][];
  dimension: number;
  light: boolean;
}
export function videoDimensions(scene: HTMLCanvasElement) {
  const width = scene.width - (scene.width % 2);
  const height = scene.height + Math.ceil(200 * Math.max(1, width / 1100));
  return { width, height: height - (height % 2) };
}
/** Metadata occupies its own bands, preserving the complete scene viewport. */
export function captureViewport(
  scene: HTMLCanvasElement,
  labels: CaptureLabels,
  width = videoDimensions(scene).width,
  height = videoDimensions(scene).height,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width - (width % 2);
  canvas.height = height - (height % 2);
  const c = canvas.getContext("2d")!;
  const scale = Math.max(1, canvas.width / 1100);
  c.fillStyle = labels.light ? "#f7fafc" : "#101923";
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.drawImage(scene, 0, 100 * scale, canvas.width, canvas.height - 200 * scale);
  c.scale(scale, scale);
  const w = canvas.width / scale,
    h = canvas.height / scale;
  const fg = labels.light ? "#122330" : "#e7eff4",
    bg = labels.light ? "#f7fafc" : "#101923";
  c.fillStyle = bg;
  c.fillRect(12, 12, w - 24, 86);
  c.fillStyle = fg;
  c.font = "bold 19px system-ui";
  c.fillText(labels.title, 24, 37, w - 48);
  c.font = "14px system-ui";
  c.fillText(labels.quantity, 24, 60, w - 48);
  c.font = "12px system-ui";
  c.fillText(labels.details, 24, 81, w - 48);
  c.fillStyle = bg;
  c.fillRect(12, h - 104, Math.min(w - 24, 390), 92);
  c.fillStyle = fg;
  c.fillText(`${labels.particles.toLocaleString()} particles`, 24, h - 83);
  c.fillText(labels.quantity, 24, h - 62, 350);
  const grad = c.createLinearGradient(24, 0, 324, 0),
    stops = (palettes[labels.palette] ?? palettes.viridis).stops;
  stops.forEach((stop, i) => grad.addColorStop(i / (stops.length - 1), stop));
  c.fillStyle = grad;
  c.fillRect(24, h - 51, 300, 10);
  c.fillStyle = fg;
  c.textAlign = "left";
  c.fillText(labels.range[0].toPrecision(5), 24, h - 23);
  c.textAlign = "right";
  c.fillText(labels.range[1].toPrecision(5), 324, h - 23);
  c.textAlign = "left";
  labels.axes.slice(0, labels.dimension).forEach(([x, y], i) => {
    c.strokeStyle = c.fillStyle = ["#d88d82", "#74bf9c", "#8baee4"][i];
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(w - 55, h - 50);
    c.lineTo(w - 55 + x * 25, h - 50 - y * 25);
    c.stroke();
    c.fillText("XYZ"[i], w - 59 + x * 36, h - 46 - y * 36);
  });
  return canvas;
}
export function saveVideo(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
