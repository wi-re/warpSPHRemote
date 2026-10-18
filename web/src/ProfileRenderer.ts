import type { ViewportSettings } from "./recording";
import { mappedCoordinate } from "./spatial";
import type { ParticleRenderer } from "./renderer";
import type { Frame, Source, ViewOptions } from "./types";
import { fieldLabel, formatNumber, scalarRange, scalarValues } from "./data";
import { paletteBytes } from "./palettes";
import { periodicColorValue } from "./periodicColor";
import {
  axisTick,
  finiteExtent,
  physicalEdges,
  profileSamples,
} from "./profile1d";

/** Profile viewport shares acquisition/ACK/export lifecycle with the particle scene. */
export class ProfileRenderer {
  frame?: Frame;
  source?: Source;
  field = "";
  values: Float32Array = new Float32Array();
  range: [number, number] = [0, 1];
  validRange = true;
  onPick = (i: number) => {};
  onRender = (ms: number) => {};
  onFollowChanged = () => {};
  follow = true;
  private selected = -1;
  private picking = false;
  private options?: ViewOptions;
  private x: [number, number] = [0, 1];
  private y: [number, number] = [0, 1];
  private canvas = document.createElement("canvas");
  private observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private disposed = false;
  private drag?: {
    x: number;
    y: number;
    left: [number, number];
    bottom: [number, number];
    moved: boolean;
  };
  constructor(private host: HTMLDivElement) {
    host.append(this.canvas);
    this.canvas.setAttribute("role", "img");
    this.canvas.style.cssText = "width:100%;height:100%;touch-action:none";
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(host);
    this.canvas.addEventListener("pointerdown", this.down);
    this.canvas.addEventListener("pointermove", this.move);
    this.canvas.addEventListener("pointerup", this.up);
    this.canvas.addEventListener("pointercancel", this.cancel);
    this.canvas.addEventListener("wheel", this.wheel, { passive: false });
  }
  private bounds() {
    return {
      left: 82,
      right: Math.max(130, this.width - 36),
      top: this.width < 500 ? 170 : 135,
      bottom: Math.max(160, this.height - 85),
    };
  }
  private point(x: number, y: number) {
    const b = this.bounds();
    return [
      b.left + ((x - this.x[0]) / (this.x[1] - this.x[0])) * (b.right - b.left),
      b.bottom -
        ((y - this.y[0]) / (this.y[1] - this.y[0])) * (b.bottom - b.top),
    ];
  }
  private location(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = this.location(e);
    this.drag = { x, y, left: [...this.x], bottom: [...this.y], moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || this.picking) return;
    const [x, y] = this.location(e),
      b = this.bounds();
    if (Math.hypot(x - d.x, y - d.y) > 3) d.moved = true;
    if (!d.moved) return;
    this.follow = false;
    this.onFollowChanged();
    const dx = ((x - d.x) / (b.right - b.left)) * (d.left[1] - d.left[0]),
      dy = ((y - d.y) / (b.bottom - b.top)) * (d.bottom[1] - d.bottom[0]);
    this.x = [d.left[0] - dx, d.left[1] - dx];
    this.y = [d.bottom[0] + dy, d.bottom[1] + dy];
    this.draw();
  };
  private up = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = undefined;
    if (
      !d ||
      d.moved ||
      !this.picking ||
      !this.frame ||
      !this.source ||
      !this.options
    )
      return;
    const [x, y] = this.location(e);
    let best = -1,
      dist = 12;
    for (const p of profileSamples(
      this.frame,
      this.source,
      this.field,
      this.options,
    )) {
      const [px, py] = this.point(p.x, p.y),
        r = Math.hypot(px - x, py - y);
      if (r < dist) {
        best = p.i;
        dist = r;
      }
    }
    this.select(best);
    this.onPick(best);
  };
  private cancel = () => {
    this.drag = undefined;
  };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.location(e),
      b = this.bounds(),
      scale = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.001)));
    this.follow = false;
    this.onFollowChanged();
    const zoom = (a: [number, number], f: number): [number, number] => {
      const c = a[0] + f * (a[1] - a[0]);
      return [c + (a[0] - c) * scale, c + (a[1] - c) * scale];
    };
    this.x = zoom(this.x, (x - b.left) / (b.right - b.left));
    this.y = zoom(this.y, 1 - (y - b.top) / (b.bottom - b.top));
    this.draw();
  };
  setFrame(frame: Frame, source: Source, field: string, options: ViewOptions) {
    const changed = this.source?.id !== source.id || this.field !== field;
    this.frame = frame;
    this.source = source;
    this.field = field;
    this.options = { ...options };
    this.updateRange();
    if (changed || this.follow) this.fit();
    else this.draw();
  }
  private updateRange() {
    if (!this.frame || !this.options) return;
    this.values = scalarValues(this.frame, this.field, this.options.mapping);
    const auto = scalarRange(
      this.values,
      this.frame.arrays.kinds?.data,
      this.options.normalization === "log",
    );
    this.validRange = !!auto;
    this.range =
      this.options.range === "fixed"
        ? [this.options.min, this.options.max]
        : (auto ?? [0, 1]);
  }
  setOptions(options: ViewOptions) {
    if (!this.frame || !this.source) return;
    const remap =
      this.options?.mapping !== options.mapping ||
      this.options?.wrapPeriodic !== options.wrapPeriodic;
    this.options = { ...options };
    this.updateRange();
    if (remap || this.follow) this.fit();
    else this.draw();
  }
  fit() {
    if (!this.frame || !this.source || !this.options) return;
    const p = profileSamples(this.frame, this.source, this.field, this.options);
    this.x = finiteExtent(
      p.map((v) => v.x).concat(physicalEdges(this.frame.physicalBounds)),
    );
    this.y = finiteExtent(p.map((v) => v.y));
    this.draw();
  }
  select(i: number) {
    this.selected = i;
    this.draw();
  }
  setPicking(v: boolean) {
    this.picking = v;
  }
  axes() {
    return [
      [1, 0],
      [0, 1],
      [0, 0],
    ];
  }
  setFieldView(..._args: Parameters<ParticleRenderer["setFieldView"]>) {}
  setLICAnimation(..._args: Parameters<ParticleRenderer["setLICAnimation"]>) {}
  setTrace(..._args: Parameters<ParticleRenderer["setTrace"]>) {}
  setMaterial(..._args: Parameters<ParticleRenderer["setMaterial"]>) {}
  private probes: Parameters<ParticleRenderer["setProbes"]>[0] = [];
  setProbes(probes: Parameters<ParticleRenderer["setProbes"]>[0]) {
    this.probes = probes;
    this.draw();
  }
  private draw() {
    if (this.disposed) return;
    const start = performance.now(),
      w = Math.max(1, this.host.clientWidth),
      h = Math.max(260, this.host.clientHeight),
      dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = w;
    this.host.parentElement?.setAttribute(
      "data-profile-narrow",
      String(w < 500),
    );
    this.height = h;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    const c = this.canvas.getContext("2d")!;
    c.scale(dpr, dpr);
    const light = this.options?.background === "light";
    c.fillStyle = light ? "#f5f7fa" : "#101a23";
    c.fillRect(0, 0, w, h);
    if (!this.frame || !this.source || !this.options) return;
    const b = this.bounds();
    this.canvas.setAttribute(
      "aria-label",
      `1D ${fieldLabel(this.field)} profile, time ${this.frame.time}, ${this.frame.arrays.positions.shape[0]} samples. Physical x ${this.x[0]} to ${this.x[1]}; quantity ${this.y[0]} to ${this.y[1]}.`,
    );
    c.font = "12px system-ui";
    c.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const f = i / 5,
        x = b.left + f * (b.right - b.left),
        y = b.bottom - f * (b.bottom - b.top);
      c.strokeStyle = light ? "#d7dfe5" : "#283945";
      c.beginPath();
      c.moveTo(x, b.top);
      c.lineTo(x, b.bottom);
      c.moveTo(b.left, y);
      c.lineTo(b.right, y);
      c.stroke();
      c.fillStyle = light ? "#304453" : "#b3c5d3";
      c.textAlign = "center";
      c.fillText(
        axisTick(
          this.x[0] + f * (this.x[1] - this.x[0]),
          this.x[1] - this.x[0],
        ),
        x,
        b.bottom + 21,
      );
      c.textAlign = "right";
      c.fillText(
        axisTick(
          this.y[0] + f * (this.y[1] - this.y[0]),
          this.y[1] - this.y[0],
        ),
        b.left - 10,
        y + 4,
      );
    }
    c.textAlign = "left";
    c.fillText("Physical position x · recorded units", b.left, h - 16);
    c.save();
    c.translate(17, (b.top + b.bottom) / 2);
    c.rotate(-Math.PI / 2);
    c.fillText(fieldLabel(this.field) + " · recorded units", 0, 0);
    c.restore();
    c.save();
    c.beginPath();
    c.rect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    c.clip();
    c.strokeStyle = "#eeb765";
    c.setLineDash([5, 4]);
    for (const edge of physicalEdges(this.frame.physicalBounds)) {
      const [x] = this.point(edge, 0);
      c.beginPath();
      c.moveTo(x, b.top);
      c.lineTo(x, b.bottom);
      c.stroke();
    }
    c.setLineDash([]);
    for (const p of this.probes) {
      const [x] = this.point(
        mappedCoordinate(
          p.position[0],
          0,
          this.frame.domain ?? this.source.domain,
          this.options.wrapPeriodic,
        ),
        0,
      );
      c.strokeStyle = "#83dfc5";
      c.beginPath();
      c.moveTo(x, b.top);
      c.lineTo(x, b.bottom);
      c.stroke();
      c.fillStyle = "#83dfc5";
      c.textAlign = "left";
      c.fillText("name" in p ? String(p.name) : "Probe", x + 4, b.top + 15);
    }
    const lut = paletteBytes(this.options.palette),
      norm = (v: number) =>
        this.options!.normalization === "log"
          ? Math.log(v)
          : this.options!.normalization === "symlog"
            ? Math.sign(v) * Math.log1p(Math.abs(v))
            : v;
    for (const p of profileSamples(
      this.frame,
      this.source,
      this.field,
      this.options,
    )) {
      const [x, y] = this.point(p.x, p.y);
      let v = p.y,
        lo = this.range[0],
        hi = this.range[1];
      if (
        this.options.normalization === "cyclic" &&
        this.options.colorPeriod > 0
      ) {
        v = periodicColorValue(
          this.field === "UIDs" ? this.frame.arrays.UIDs.data[p.i] : v,
          this.options.colorPeriod,
        );
        lo = 0;
        hi = this.options.colorPeriod;
      }
      const f = (norm(v) - norm(lo)) / (norm(hi) - norm(lo)),
        k = Math.max(0, Math.min(255, Math.round(f * 255))) * 4;
      c.fillStyle =
        p.kind !== 0 || !Number.isFinite(f)
          ? "#8a9aa6"
          : `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
      c.beginPath();
      c.arc(x, y, Math.max(1.5, 2.4 * this.options.size), 0, Math.PI * 2);
      c.fill();
      if (p.i === this.selected) {
        c.strokeStyle = "#ffffff";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, 6, 0, Math.PI * 2);
        c.stroke();
      }
    }
    c.restore();
    c.fillStyle = light ? "#536674" : "#91a8b9";
    c.textAlign = "left";
    c.fillText(
      physicalEdges(this.frame.physicalBounds).length
        ? "Dashed: physical boundaries"
        : "Physical boundaries not recorded · axes use sample extent",
      b.left,
      b.top - 12,
    );
    this.onRender(performance.now() - start);
  }
  viewportSettings(): ViewportSettings {
    return {
      kind: "profile",
      x: [...this.x],
      y: [...this.y],
      follow: this.follow,
    };
  }
  restoreViewport(v: ViewportSettings) {
    if (v.kind !== "profile") return;
    this.x = [...v.x];
    this.y = [...v.y];
    this.follow = v.follow;
    this.onFollowChanged();
    this.draw();
  }
  captureCanvas() {
    this.draw();
    return this.canvas;
  }
  exportImage() {
    const a = document.createElement("a");
    a.download = `profile-${this.field}-${this.frame?.index}.png`;
    a.href = this.captureCanvas().toDataURL("image/png");
    a.click();
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.cancel);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.remove();
  }
}
