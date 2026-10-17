import { mappedCoordinate, mappedPosition } from "./spatial";
import { traceSegments, type TraceSample } from "./sources/traces";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { paletteBytes } from "./palettes";
import { scalarValues, scalarRange } from "./data";
import type { Frame, Source, ViewOptions } from "./types";

const vertex = `
attribute vec3 aCenter;
attribute float aValue;
attribute float aRadius;
attribute float aKind;
attribute float aIndex;
uniform float uHeight;
uniform float uScale;
uniform float uPhysical;
uniform float uBoundaries;
uniform float uGhosts;
uniform float uClipAxis;
uniform float uClip;
uniform float uSelected;
varying vec2 vUv;
varying float vValue;
varying float vKind;
varying float vHidden;
varying float vSelected;
varying vec3 vCenter;
varying float vRadius;
void main(){
 vUv=position.xy;vValue=aValue;vKind=aKind;vSelected=abs(aIndex-uSelected)<0.1?1.0:0.0;
 vHidden=(aKind>0.5&&aKind<1.5&&uBoundaries<0.5)||(aKind>1.5&&uGhosts<0.5)?1.0:0.0;
 float coordinate=uClipAxis<0.5?aCenter.x:(uClipAxis<1.5?aCenter.y:aCenter.z);
 if(uClipAxis>=0.0&&coordinate>uClip)vHidden=1.0;
 vec4 center=modelViewMatrix*vec4(aCenter,1.0);
 float radius=uPhysical>0.5?aRadius*uScale:4.0*uScale/(uHeight*projectionMatrix[1][1]);
 vRadius=radius;vCenter=center.xyz;
 center.xy+=position.xy*radius;
 gl_Position=projectionMatrix*center;
}`;
const fragment = `
uniform mat4 projectionMatrix;
uniform sampler2D uPalette;
uniform float uMin;
uniform float uMax;
uniform float uNorm;
uniform float u3D;
uniform float uLight;
varying vec2 vUv;
varying float vValue;
varying float vKind;
varying float vHidden;
varying float vSelected;
varying vec3 vCenter;
varying float vRadius;
float transformValue(float v){if(uNorm<0.5)return v;if(uNorm<1.5)return log(max(v,1.e-30));float a=abs(v);return sign(v)*(a<0.01?a*(1.0-a*(0.5-a/3.0)):log(1.0+a));}
void main(){
 float r2=dot(vUv,vUv);if(r2>1.0||vHidden>0.5)discard;
 float alpha=1.0-smoothstep(1.0-fwidth(r2)*1.5,1.0,r2);
 bool invalid=(vValue!=vValue)||abs(vValue)>3.4e38||(uNorm>0.5&&uNorm<1.5&&vValue<=0.0);
 float t=clamp((transformValue(vValue)-transformValue(uMin))/(transformValue(uMax)-transformValue(uMin)),0.0,1.0);
 vec3 color=texture2D(uPalette,vec2(t,0.5)).rgb;
 if(invalid)color=vec3(0.5);
 if(vKind>0.5)color=uLight>0.5?vec3(0.45,0.50,0.55):vec3(0.43,0.51,0.59);
 if(vSelected>0.5&&r2>0.5)color=vec3(1.0);
 if(u3D>0.5){
  float z=sqrt(max(0.0,1.0-r2));
  color*=0.70+0.30*max(0.0,dot(vec3(vUv,z),normalize(vec3(-0.35,0.5,1.0))));
  vec4 clip=projectionMatrix*vec4(vCenter+vec3(0.0,0.0,z*vRadius),1.0);
  gl_FragDepth=clip.z/clip.w*0.5+0.5;
 }
 gl_FragColor=vec4(color,alpha);
}`;

export class ParticleRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10000);
  controls: OrbitControls;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  geometry = new THREE.InstancedBufferGeometry();
  texture = new THREE.DataTexture(paletteBytes("viridis"), 256, 1);
  grid = new THREE.Group();
  probeMarkers = new THREE.Group();
  traceLines = new THREE.Group();
  frame: Frame | null = null;
  source: Source | null = null;
  options: ViewOptions | null = null;
  field = "velocities";
  values: Float32Array = new Float32Array();
  range: [number, number] = [0, 1];
  validRange = true;
  selected = -1;
  dirty = true;
  width = 1;
  height = 1;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private down = [0, 0];
  private bounds = new THREE.Box3();
  private span = 1;
  onPick: (index: number) => void = () => {};
  onRender: (ms: number) => void = () => {};
  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor("#101923");
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive particle scene. Drag to pan in 2D or rotate in 3D; scroll to zoom; click to inspect.",
    );
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
        3,
      ),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uPalette: { value: this.texture },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uNorm: { value: 0 },
        uHeight: { value: 1 },
        uScale: { value: 1 },
        uPhysical: { value: 1 },
        uBoundaries: { value: 1 },
        uGhosts: { value: 0 },
        uClipAxis: { value: -1 },
        uClip: { value: 0 },
        u3D: { value: 0 },
        uLight: { value: 0 },
        uSelected: { value: -1 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh, this.grid, this.probeMarkers, this.traceLines);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => {
      this.dirty = true;
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.pointerUp);
    this.resize();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.dirty) {
        const t = performance.now();
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
        this.onRender(performance.now() - t);
      }
    };
    tick();
  }
  private pointerDown = (e: PointerEvent) => {
    this.down = [e.clientX, e.clientY];
  };
  private pointerUp = (e: PointerEvent) => {
    if (
      e.button === 0 &&
      Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 4
    )
      this.pick(e);
  };
  private resize() {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    const half = (this.camera.top - this.camera.bottom) / 2 || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.camera.left = (-half * w) / h;
    this.camera.right = (half * w) / h;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uHeight.value = h;
    this.dirty = true;
  }
  private updateAttribute(name: string, data: Float32Array, size: number) {
    const previous = this.geometry.getAttribute(name) as
      THREE.InstancedBufferAttribute | undefined;
    if (previous && previous.array.length === data.length) {
      previous.array.set(data);
      previous.needsUpdate = true;
    } else
      this.geometry.setAttribute(
        name,
        new THREE.InstancedBufferAttribute(data, size).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
  }
  setProbes(probes: { position: number[]; radius: number }[]) {
    for (const child of [...this.probeMarkers.children]) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this.probeMarkers.remove(child);
    }
    probes.forEach((p, i) => {
      const center = [
          ...mappedPosition(
            p.position,
            this.source?.domain,
            this.options?.wrapPeriodic,
          ),
          0,
        ].slice(0, 3),
        points: number[] = [],
        size = this.span * 0.009;
      for (let c = 0; c < (this.source?.dimension ?? 2); c++) {
        const a = [...center],
          b = [...center];
        a[c] -= size;
        b[c] += size;
        points.push(...a, ...b);
      }
      if (this.source?.dimension === 2)
        for (let j = 0; j < 64; j++) {
          for (const k of [j, j + 1])
            points.push(
              center[0] + p.radius * Math.cos((k * Math.PI) / 32),
              center[1] + p.radius * Math.sin((k * Math.PI) / 32),
              center[2],
            );
        }
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(points, 3),
        ),
        new THREE.LineBasicMaterial({
          color: ["#75ddba", "#e6b873", "#91aafa", "#e78aab"][i],
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        }),
      );
      line.renderOrder = 100;
      this.probeMarkers.add(line);
    });
    this.dirty = true;
  }
  setTrace(rows: TraceSample[], current: number) {
    for (const child of [...this.traceLines.children]) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this.traceLines.remove(child);
    }
    const paths = traceSegments(
      rows,
      current,
      this.source?.domain,
      this.options?.wrapPeriodic,
    );
    for (const [name, points] of Object.entries(paths)) {
      if (!points.length) continue;
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(points, 3),
        ),
        new THREE.LineBasicMaterial({
          color: name === "past" ? "#75ddba" : "#e6b873",
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      line.renderOrder = 90;
      this.traceLines.add(line);
    }
    const currentPoint = rows.find((r) => r.index === current)?.position;
    if (currentPoint) {
      const center = [
          ...mappedPosition(
            currentPoint,
            this.source?.domain,
            this.options?.wrapPeriodic,
          ),
          0,
        ].slice(0, 3),
        points: number[] = [],
        size = this.span * 0.006;
      for (let c = 0; c < (this.source?.dimension ?? 2); c++) {
        const a = [...center],
          b = [...center];
        a[c] -= size;
        b[c] += size;
        points.push(...a, ...b);
      }
      const marker = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(points, 3),
        ),
        new THREE.LineBasicMaterial({ color: "#ffffff", depthTest: false }),
      );
      marker.renderOrder = 95;
      this.traceLines.add(marker);
    }
    this.dirty = true;
  }
  setFrame(frame: Frame, source: Source, field: string, options: ViewOptions) {
    const changed = this.source?.id !== source.id;
    this.frame = frame;
    this.source = source;
    this.field = field;
    this.selected = -1;
    const p = frame.arrays.positions,
      n = p.shape[0],
      dim = p.shape[1],
      centers = new Float32Array(n * 3);
    for (let i = 0; i < n; i++)
      for (let c = 0; c < dim; c++)
        centers[i * 3 + c] = mappedCoordinate(
          Number(p.data[i * dim + c]),
          c,
          source.domain,
          options.wrapPeriodic,
        );
    const radius = new Float32Array(n),
      kind = new Float32Array(n),
      indices = new Float32Array(n);
    const a = frame.arrays;
    let fallback = 0;
    for (let c = 0; c < dim; c++)
      fallback = Math.max(fallback, source.bounds[1][c] - source.bounds[0][c]);
    fallback = (fallback / Math.pow(Math.max(n, 1), 1 / dim)) * 0.35;
    for (let i = 0; i < n; i++) {
      const m = Number(a.masses?.data[i]),
        rho = Number(a.densities?.data[i]),
        support = Number(a.supports?.data[i]);
      radius[i] =
        m > 0 && rho > 0 && Number.isFinite(m / rho)
          ? Math.pow(m / rho, 1 / dim) * 0.4
          : support > 0
            ? support * 0.2
            : fallback;
      kind[i] = Number(a.kinds?.data[i] ?? 0);
      indices[i] = i;
    }
    if (this.geometry.instanceCount !== n) this.geometry.dispose();
    this.updateAttribute("aCenter", centers, 3);
    this.updateAttribute("aRadius", radius, 1);
    this.updateAttribute("aKind", kind, 1);
    this.updateAttribute("aIndex", indices, 1);
    this.geometry.instanceCount = n;
    this.bounds.makeEmpty();
    const point = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      point.fromArray(centers, i * 3);
      this.bounds.expandByPoint(point);
    }
    if (options.wrapPeriodic && source.domain)
      source.domain.periodic.forEach((periodic, c) => {
        if (periodic) {
          this.bounds.min.setComponent(c, source.domain!.min[c]);
          this.bounds.max.setComponent(c, source.domain!.max[c]);
        }
      });
    if (changed) {
      this.selected = -1;
      this.buildGrid();
      this.fit();
    }
    this.setOptions(options, true);
  }
  setOptions(options: ViewOptions, force = false) {
    const old = this.options;
    if (
      this.frame &&
      this.source &&
      old &&
      old.wrapPeriodic !== options.wrapPeriodic
    ) {
      this.options = { ...options };
      this.setFrame(this.frame, this.source, this.field, options);
      this.buildGrid();
      this.fit();
      return;
    }
    if (
      this.frame &&
      (force ||
        old?.mapping !== options.mapping ||
        old?.normalization !== options.normalization ||
        old?.range !== options.range ||
        old?.min !== options.min ||
        old?.max !== options.max)
    ) {
      this.values = scalarValues(this.frame, this.field, options.mapping);
      this.updateAttribute("aValue", this.values, 1);
      const auto = scalarRange(
        this.values,
        this.frame.arrays.kinds?.data,
        options.normalization === "log",
      );
      this.validRange = auto !== null;
      const fixed =
        options.range === "fixed" &&
        Number.isFinite(options.min) &&
        Number.isFinite(options.max) &&
        options.max > options.min &&
        (options.normalization !== "log" || options.min > 0);
      this.range = fixed
        ? [options.min, options.max]
        : (auto ?? (options.normalization === "log" ? [0.1, 1] : [0, 1]));
    }
    if (old?.palette !== options.palette) {
      this.texture.image.data.set(paletteBytes(options.palette));
      this.texture.needsUpdate = true;
    }
    const u = this.material.uniforms;
    u.uMin.value = this.range[0];
    u.uMax.value = this.range[1];
    u.uNorm.value = { linear: 0, log: 1, symlog: 2 }[options.normalization];
    u.uScale.value = options.size;
    u.uPhysical.value = +options.physical;
    u.uBoundaries.value = +options.boundaries;
    u.uGhosts.value = +options.ghosts;
    u.uClipAxis.value = options.clipAxis;
    if (options.clipAxis >= 0) {
      const c = options.clipAxis;
      u.uClip.value =
        this.bounds.min.getComponent(c) +
        (this.bounds.max.getComponent(c) - this.bounds.min.getComponent(c)) *
          options.clip;
    }
    u.u3D.value = this.source?.dimension === 3 ? 1 : 0;
    u.uLight.value = options.background === "light" ? 1 : 0;
    u.uSelected.value = this.selected;
    this.grid.visible = options.grid;
    this.renderer.setClearColor(
      options.background === "light" ? "#eef2f5" : "#101923",
    );
    this.options = { ...options };
    this.dirty = true;
  }
  fit() {
    if (!this.source) return;
    const center = this.bounds.getCenter(new THREE.Vector3()),
      size = this.bounds.getSize(new THREE.Vector3());
    this.span = Math.max(size.x, size.y, size.z, 0.001);
    const availableW = Math.max(this.width - 90, this.width * 0.6),
      availableH = Math.max(this.height - 80, this.height * 0.45);
    let half =
      Math.max(
        (size.y * this.height) / availableH,
        (size.x * this.height) / availableW,
      ) * 0.53;
    if (this.source.dimension === 3)
      half = this.span * 1.05 * Math.max(1, this.height / this.width);
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.left = (-half * this.width) / this.height;
    this.camera.right = (half * this.width) / this.height;
    this.camera.zoom = 1;
    this.camera.near = this.span * 0.001;
    this.camera.far = this.span * 20;
    this.camera.position
      .copy(center)
      .add(
        this.source.dimension === 3
          ? new THREE.Vector3(1.3, -1.7, 1.3).multiplyScalar(this.span)
          : new THREE.Vector3(0, 0, this.span * 3),
      );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.enableRotate = this.source.dimension === 3;
    this.controls.mouseButtons.LEFT =
      this.source.dimension === 3 ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.update();
    this.dirty = true;
  }
  private buildGrid() {
    while (this.grid.children.length) {
      const child = this.grid.children[0] as THREE.LineSegments;
      this.grid.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    const min = this.bounds.min,
      max = this.bounds.max,
      positions = [];
    const span = Math.max(max.x - min.x, max.y - min.y, 0.001),
      step = 10 ** Math.floor(Math.log10(span)) / 2;
    const z = min.z - span * 0.01;
    for (let x = Math.ceil(min.x / step) * step; x <= max.x; x += step)
      positions.push(x, min.y, z, x, max.y, z);
    for (let y = Math.ceil(min.y / step) * step; y <= max.y; y += step)
      positions.push(min.x, y, z, max.x, y, z);
    const geom = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.grid.add(
      new THREE.LineSegments(
        geom,
        new THREE.LineBasicMaterial({
          color: "#70889d",
          transparent: true,
          opacity: 0.12,
        }),
      ),
    );
    const box = new THREE.Box3Helper(
      this.bounds.clone(),
      new THREE.Color("#68839a"),
    );
    (box.material as THREE.LineBasicMaterial).transparent = true;
    (box.material as THREE.LineBasicMaterial).opacity = 0.3;
    this.grid.add(box);
  }
  select(index: number) {
    this.selected = index;
    this.material.uniforms.uSelected.value = index;
    this.dirty = true;
  }
  private pick(e: PointerEvent) {
    if (!this.frame || !this.options) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    const points = this.geometry.getAttribute("aCenter"),
      kinds = this.geometry.getAttribute("aKind");
    const p = new THREE.Vector3();
    let best = -1,
      distance = 10;
    for (let i = 0; i < points.count; i++) {
      const kind = kinds.getX(i);
      if (
        (kind === 1 && !this.options.boundaries) ||
        (kind > 1 && !this.options.ghosts)
      )
        continue;
      p.fromBufferAttribute(points, i);
      if (
        this.options.clipAxis >= 0 &&
        p.getComponent(this.options.clipAxis) >
          this.material.uniforms.uClip.value
      )
        continue;
      p.project(this.camera);
      if (p.z < -1 || p.z > 1) continue;
      const d = Math.hypot(
        ((p.x + 1) * this.width) / 2 - x,
        ((1 - p.y) * this.height) / 2 - y,
      );
      if (d < distance) {
        distance = d;
        best = i;
      }
    }
    this.select(best);
    this.onPick(best);
  }
  axes() {
    this.camera.updateMatrixWorld();
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((a) => {
      const v = new THREE.Vector3(...a).transformDirection(
        this.camera.matrixWorldInverse,
      );
      return [v.x, v.y];
    });
  }
  exportImage() {
    this.renderer.render(this.scene, this.camera);
    const link = document.createElement("a");
    link.download = `warpsph-${this.source?.id}-frame-${this.frame?.index}.png`;
    link.href = this.renderer.domElement.toDataURL("image/png");
    link.click();
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
    );
    this.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.grid.traverse((o) => {
      if (o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.setTrace([], 0);
    this.setProbes([]);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
