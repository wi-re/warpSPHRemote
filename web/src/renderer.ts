import type { ViewportSettings } from "./recording";
import { particleCoverageGLSL } from "./particleCoverage";
import { periodicColorValue } from "./periodicColor";
import { fieldFragment } from "./fieldShader";
import {
  deformation,
  type MaterialSeed,
  type MaterialSample,
} from "./sources/material";
import {
  matchesFieldResult,
  derivativeQuantity,
  gridQuantityLabel,
  type FieldResult,
} from "./sources/grid";
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
uniform float uPixelRatio;
uniform float uScale;
uniform float uPhysical;
uniform float uBoundaries;
uniform float uFluid;
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
varying float vPixelRadius;
void main(){
 vValue=aValue;vKind=aKind;vSelected=abs(aIndex-uSelected)<0.1?1.0:0.0;
 vHidden=(aKind<0.5&&uFluid<0.5)||(aKind>0.5&&aKind<1.5&&uBoundaries<0.5)||(aKind>1.5&&uGhosts<0.5)?1.0:0.0;
 float coordinate=uClipAxis<0.5?aCenter.x:(uClipAxis<1.5?aCenter.y:aCenter.z);
 if(uClipAxis>=0.0&&coordinate>uClip)vHidden=1.0;
 vec4 center=modelViewMatrix*vec4(aCenter,1.0);
 float radius=uPhysical>0.5?aRadius*uScale:4.0*uScale/(uHeight*projectionMatrix[1][1]);
 // Expand geometry to contain the entire pixel filter, including its outer fringe.
 float pixelsPerWorld=0.5*uHeight*uPixelRatio*abs(projectionMatrix[1][1]);
 radius=max(radius,1.e-8);
 float paddedRadius=radius+1.0/pixelsPerWorld;
 vPixelRadius=radius*pixelsPerWorld;
 vUv=position.xy*paddedRadius/radius;
 vRadius=radius;vCenter=center.xyz;
 center.xy+=position.xy*paddedRadius;
 gl_Position=projectionMatrix*center;
}`;
const fragment = `
uniform mat4 projectionMatrix;
uniform sampler2D uPalette;
uniform float uMin;
uniform float uMax;
uniform float uNorm;
uniform float uColorPeriod;
uniform float u3D;
uniform float uLight;
uniform float uNeutral;
varying vec2 vUv;
varying float vValue;
varying float vKind;
varying float vHidden;
varying float vSelected;
varying vec3 vCenter;
varying float vRadius;
varying float vPixelRadius;
${particleCoverageGLSL}
float transformValue(float v){if(uNorm<0.5)return v;if(uNorm<1.5)return log(max(v,1.e-30));float a=abs(v);return sign(v)*(a<0.01?a*(1.0-a*(0.5-a/3.0)):log(1.0+a));}
void main(){
 if(vHidden>0.5)discard;
 float r2=dot(vUv,vUv);
 float alpha=diskCoverage(vUv,vPixelRadius);
 if(alpha<=0.0)discard;
 gl_FragDepth=gl_FragCoord.z;
 bool invalid=(vValue!=vValue)||abs(vValue)>3.4e38||(uNorm>0.5&&uNorm<1.5&&vValue<=0.0);
 float t=uNorm>2.5?fract(vValue/uColorPeriod):clamp((transformValue(vValue)-transformValue(uMin))/(transformValue(uMax)-transformValue(uMin)),0.0,1.0);
 vec3 color=texture2D(uPalette,vec2(t,0.5)).rgb;
 if(invalid)color=vec3(0.5);
 if(vKind>0.5||uNeutral>0.5)color=uLight>0.5?vec3(0.45,0.50,0.55):vec3(0.43,0.51,0.59);
 if(vSelected>0.5&&r2>0.5)color=vec3(1.0);
 if(u3D>0.5){
  float z=sqrt(max(0.0,1.0-r2));
  color*=0.70+0.30*max(0.0,dot(vec3(vUv/max(1.0,sqrt(r2)),z),normalize(vec3(-0.35,0.5,1.0))));
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
  materialLines = new THREE.Group();
  fieldPlane: THREE.Mesh;
  fieldMaterial: THREE.ShaderMaterial;
  fieldTexture = new THREE.DataTexture(
    new Float32Array([NaN]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType,
  );
  licTexture = new THREE.DataTexture(
    new Float32Array([1]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType,
  );
  velocityTexture = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  private renderReportTime = 0;
  flowLines = new THREE.Group();
  fieldResult: FieldResult | null = null;
  fieldMode: "particles" | "grid" | "both" = "particles";
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
  picking = false;
  setPicking(enabled: boolean) {
    this.picking = enabled;
    this.renderer.domElement.style.cursor = enabled ? "crosshair" : "grab";
  }
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
        uColorPeriod: { value: 256 },
        uHeight: { value: 1 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uScale: { value: 1 },
        uPhysical: { value: 1 },
        uBoundaries: { value: 1 },
        uFluid: { value: 1 },
        uGhosts: { value: 0 },
        uClipAxis: { value: -1 },
        uClip: { value: 0 },
        u3D: { value: 0 },
        uLight: { value: 0 },
        uNeutral: { value: 0 },
        uSelected: { value: -1 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.fieldTexture.minFilter = THREE.NearestFilter;
    this.fieldTexture.magFilter = THREE.NearestFilter;
    this.fieldMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uField: { value: this.fieldTexture },
        uLIC: { value: this.licTexture },
        uHasLIC: { value: 0 },
        uLICAnimate: { value: 0 },
        uLICSpeed: { value: 6 },
        uLICTime: { value: 0 },
        uVelocity: { value: this.velocityTexture },
        uGridSize: { value: new THREE.Vector2(1, 1) },
        uDomainSize: { value: new THREE.Vector2(1, 1) },
        uPeriodic: { value: new THREE.Vector2(0, 0) },
        uPalette: { value: this.texture },
        uMin: this.material.uniforms.uMin,
        uMax: this.material.uniforms.uMax,
        uNorm: this.material.uniforms.uNorm,
        uColorPeriod: this.material.uniforms.uColorPeriod,
      },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: fieldFragment,
    });
    this.fieldPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      this.fieldMaterial,
    );
    this.fieldPlane.visible = false;
    this.fieldPlane.renderOrder = -1;
    this.scene.add(this.fieldPlane, this.flowLines);

    this.scene.add(
      this.mesh,
      this.grid,
      this.probeMarkers,
      this.traceLines,
      this.materialLines,
    );
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
      const animate =
        this.fieldPlane.visible &&
        this.fieldMaterial.uniforms.uHasLIC.value > 0.5 &&
        this.fieldMaterial.uniforms.uLICAnimate.value > 0.5 &&
        !document.hidden;
      if (this.dirty || animate) {
        const t = performance.now();
        if (animate)
          this.fieldMaterial.uniforms.uLICTime.value = (t / 1000) % 1024;
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
        if (!animate || t - this.renderReportTime > 250) {
          this.renderReportTime = t;
          this.onRender(performance.now() - t);
        }
      }
    };
    tick();
  }
  setLICAnimation(enabled: boolean, speed: number) {
    this.fieldMaterial.uniforms.uLICAnimate.value = enabled ? 1 : 0;
    this.fieldMaterial.uniforms.uLICSpeed.value = Math.max(
      1,
      Math.min(20, speed),
    );
    this.dirty = true;
  }
  private pointerDown = (e: PointerEvent) => {
    this.down = [e.clientX, e.clientY];
  };
  private pointerUp = (e: PointerEvent) => {
    if (
      this.picking &&
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
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
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
  setMaterial(
    seed: MaterialSeed | null,
    rows: MaterialSample[],
    current: number,
    fade: boolean,
    ellipse = false,
  ) {
    for (const child of [...this.materialLines.children]) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this.materialLines.remove(child);
    }
    if (!seed) {
      this.dirty = true;
      return;
    }
    for (let k = 0; k < seed.uids.length; k++) {
      const points: number[] = [],
        colors: number[] = [];
      const traces = rows.map((row) => ({
        index: row.index,
        time: row.time,
        position: row.positions[k],
      }));
      for (let j = 1; j < traces.length; j++) {
        const a = traces[j - 1],
          b = traces[j],
          paths = traceSegments(
            [a, b],
            current,
            this.source?.domain,
            this.options?.wrapPeriodic,
          );
        const phase = b.index <= current ? "past" : "future",
          segment = paths[phase];
        if (!segment.length) continue;
        const age =
          Math.abs(b.index - current) /
          Math.max(
            1,
            Math.abs(rows[0].index - current),
            Math.abs(rows.at(-1)!.index - current),
          );
        const color = new THREE.Color(
          k === 0 ? "#ffffff" : phase === "past" ? "#75ddba" : "#e6b873",
        );
        color.multiplyScalar(fade ? 1 - 0.75 * Math.min(1, age) : 1);
        points.push(...segment);
        for (let v = 0; v < 2; v++) colors.push(color.r, color.g, color.b);
      }
      if (points.length) {
        const geometry = new THREE.BufferGeometry()
          .setAttribute("position", new THREE.Float32BufferAttribute(points, 3))
          .setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        const line = new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            vertexColors: true,
            depthTest: false,
            transparent: true,
            opacity: k === 0 ? 1 : 0.72,
          }),
        );
        line.renderOrder = 92;
        this.materialLines.add(line);
      }
    }
    const row = rows.find((r) => r.index === current),
      markers: number[] = [];
    for (const point of row?.positions ?? [])
      if (point) {
        const center = [
            ...mappedPosition(
              point,
              this.source?.domain,
              this.options?.wrapPeriodic,
            ),
            0,
          ].slice(0, 3),
          size = this.span * 0.003;
        for (let c = 0; c < (this.source?.dimension ?? 2); c++) {
          const a = [...center],
            b = [...center];
          a[c] -= size;
          b[c] += size;
          markers.push(...a, ...b);
        }
      }
    if (markers.length) {
      const marker = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(markers, 3),
        ),
        new THREE.LineBasicMaterial({ color: "#e78aab", depthTest: false }),
      );
      marker.renderOrder = 96;
      this.materialLines.add(marker);
    }
    if (ellipse && row?.positions[0] && this.source?.dimension === 2) {
      const d = deformation(seed, row, 0.25),
        F = d.matrix;
      if (F && d.residual != null && d.residual <= 0.25) {
        const local = seed.relative
            .slice(1, seed.fitCount)
            .filter((p): p is number[] => !!p),
          radius = Math.sqrt(
            local.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2, 0) /
              Math.max(1, local.length),
          );
        const curve = Array.from({ length: 97 }, (_, i) => {
          const a = (2 * Math.PI * i) / 96,
            x = radius * Math.cos(a),
            y = radius * Math.sin(a);
          return {
            index: i,
            time: 0,
            position: [
              row.positions[0]![0] + F[0] * x + F[1] * y,
              row.positions[0]![1] + F[2] * x + F[3] * y,
            ],
          };
        });
        const paths = traceSegments(
            curve,
            97,
            this.source.domain,
            this.options?.wrapPeriodic,
          ),
          line = new THREE.LineSegments(
            new THREE.BufferGeometry().setAttribute(
              "position",
              new THREE.Float32BufferAttribute(paths.past, 3),
            ),
            new THREE.LineBasicMaterial({ color: "#cc95ff", depthTest: false }),
          );
        line.renderOrder = 97;
        this.materialLines.add(line);
      }
    }
    this.dirty = true;
  }
  setFieldView(
    result: FieldResult | null,
    mode: "particles" | "grid" | "both",
  ) {
    const valid = matchesFieldResult(
      result,
      this.source?.id,
      this.frame?.index,
      this.field,
      this.options?.mapping,
      mode,
    );
    this.fieldResult = valid ? result : null;
    this.fieldMode = mode;
    this.fieldMaterial.uniforms.uHasLIC.value = valid && result?.lic ? 1 : 0;
    this.fieldPlane.visible = !!valid && mode !== "particles";
    this.material.uniforms.uFluid.value = valid && mode === "grid" ? 0 : 1;
    this.renderer.domElement.setAttribute(
      "aria-label",
      `${valid && mode !== "particles" ? (mode === "grid" ? "Scalar grid" : "Grid and particles") : "Particles"}, frame ${(this.frame?.index ?? 0) + 1}${valid && derivativeQuantity(result?.grid.quantity) && mode !== "particles" ? `, ${gridQuantityLabel(result?.grid.quantity)}` : ""}${valid && result?.lines.length ? ", instantaneous streamlines" : ""}${valid && result?.lic ? ", line integral convolution" : ""}. Drag to pan in 2D or rotate in 3D; scroll to zoom; click to inspect.`,
    );
    for (const child of [...this.flowLines.children]) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      this.flowLines.remove(child);
    }
    if (valid && result) {
      const g = result.grid;
      if (result.lic) {
        const velocity = new Float32Array(g.width * g.height * 4);
        for (let i = 0; i < g.width * g.height; i++) {
          velocity[4 * i] = g.velocity[2 * i];
          velocity[4 * i + 1] = g.velocity[2 * i + 1];
          velocity[4 * i + 2] = g.velocityValid[i];
        }
        this.velocityTexture.dispose();
        this.velocityTexture = new THREE.DataTexture(
          velocity,
          g.width,
          g.height,
          THREE.RGBAFormat,
          THREE.FloatType,
        );
        this.velocityTexture.minFilter = THREE.NearestFilter;
        this.velocityTexture.magFilter = THREE.NearestFilter;
        this.velocityTexture.needsUpdate = true;
        this.fieldMaterial.uniforms.uVelocity.value = this.velocityTexture;
        this.fieldMaterial.uniforms.uGridSize.value.set(g.width, g.height);
        this.fieldMaterial.uniforms.uDomainSize.value.set(
          g.bounds[1][0] - g.bounds[0][0],
          g.bounds[1][1] - g.bounds[0][1],
        );
        this.fieldMaterial.uniforms.uPeriodic.value.set(
          +g.periodic[0],
          +g.periodic[1],
        );
        this.licTexture.dispose();
        this.licTexture = new THREE.DataTexture(
          result.lic.values,
          g.width,
          g.height,
          THREE.RedFormat,
          THREE.FloatType,
        );
        this.licTexture.minFilter = THREE.NearestFilter;
        this.licTexture.magFilter = THREE.NearestFilter;
        this.licTexture.needsUpdate = true;
        this.fieldMaterial.uniforms.uLIC.value = this.licTexture;
      }
      if (
        this.fieldTexture.image.width !== g.width ||
        this.fieldTexture.image.height !== g.height
      ) {
        this.fieldTexture.dispose();
        this.fieldTexture = new THREE.DataTexture(
          g.values,
          g.width,
          g.height,
          THREE.RedFormat,
          THREE.FloatType,
        );
        this.fieldTexture.minFilter = THREE.NearestFilter;
        this.fieldTexture.magFilter = THREE.NearestFilter;
        this.fieldMaterial.uniforms.uField.value = this.fieldTexture;
      } else this.fieldTexture.image.data = g.values;
      this.fieldTexture.needsUpdate = true;
      this.fieldPlane.scale.set(
        g.bounds[1][0] - g.bounds[0][0],
        g.bounds[1][1] - g.bounds[0][1],
        1,
      );
      this.fieldPlane.position.set(
        (g.bounds[0][0] + g.bounds[1][0]) / 2,
        (g.bounds[0][1] + g.bounds[1][1]) / 2,
        -this.span * 0.002,
      );
      if (result.lines.length) {
        const line = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute(
            "position",
            new THREE.Float32BufferAttribute(result.lines, 3),
          ),
          new THREE.LineBasicMaterial({
            color: this.options?.background === "light" ? "#44331f" : "#fff0ca",
            depthTest: false,
            transparent: true,
            opacity: 0.75,
          }),
        );
        line.renderOrder = 50;
        this.flowLines.add(line);
      }
    }
    if (this.options) this.setOptions(this.options, true);
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
        old?.colorPeriod !== options.colorPeriod ||
        old?.range !== options.range ||
        old?.min !== options.min ||
        old?.max !== options.max)
    ) {
      this.values = scalarValues(this.frame, this.field, options.mapping);
      const rawColors =
        this.field === "UIDs" ? this.frame.arrays.UIDs.data : this.values;
      const colorValues =
        options.normalization === "cyclic" && options.colorPeriod > 0
          ? Float32Array.from({ length: rawColors.length }, (_, i) =>
              periodicColorValue(rawColors[i], options.colorPeriod),
            )
          : this.values;
      this.updateAttribute("aValue", colorValues, 1);
      const matched = matchesFieldResult(
        this.fieldResult,
        this.source?.id,
        this.frame.index,
        this.field,
        options.mapping,
        this.fieldMode,
      );
      const gridValues =
        matched && this.fieldMode !== "particles"
          ? this.fieldResult!.grid.values
          : null;
      const derived =
        !!gridValues && derivativeQuantity(this.fieldResult?.grid.quantity);
      this.material.uniforms.uNeutral.value = derived ? 1 : 0;
      const auto = scalarRange(
        gridValues ?? this.values,
        gridValues ? undefined : this.frame.arrays.kinds?.data,
        options.normalization === "log",
      );
      this.validRange = auto !== null;
      const fixed =
        options.range === "fixed" &&
        Number.isFinite(options.min) &&
        Number.isFinite(options.max) &&
        options.max > options.min &&
        (options.normalization !== "log" || options.min > 0);
      this.range =
        options.normalization === "cyclic" && options.colorPeriod > 0
          ? [0, options.colorPeriod]
          : fixed
            ? [options.min, options.max]
            : derived && auto && options.normalization !== "log"
              ? [
                  -Math.max(Math.abs(auto[0]), Math.abs(auto[1])),
                  Math.max(Math.abs(auto[0]), Math.abs(auto[1])),
                ]
              : (auto ?? (options.normalization === "log" ? [0.1, 1] : [0, 1]));
    }
    if (old?.palette !== options.palette) {
      this.texture.image.data.set(paletteBytes(options.palette));
      this.texture.needsUpdate = true;
    }
    const u = this.material.uniforms;
    u.uMin.value = this.range[0];
    u.uMax.value = this.range[1];
    // A disabled period uses the ordinary linear range in both particle and grid shaders.
    u.uNorm.value =
      options.normalization === "cyclic" && options.colorPeriod === 0
        ? 0
        : { linear: 0, log: 1, symlog: 2, cyclic: 3 }[options.normalization];
    u.uColorPeriod.value = options.colorPeriod;
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
    // Coplanar 2D coverage must blend without transparent fringes occluding disks.
    // 3D retains sphere depth and occlusion, including the analytical cap depth.
    this.material.depthWrite = this.source?.dimension === 3;
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
  viewportSettings(): ViewportSettings {
    return {
      kind: "particles",
      position: this.camera.position.toArray(),
      up: this.camera.up.toArray(),
      target: this.controls.target.toArray(),
      top: this.camera.top,
      bottom: this.camera.bottom,
      zoom: this.camera.zoom,
      near: this.camera.near,
      far: this.camera.far,
    };
  }
  restoreViewport(v: ViewportSettings) {
    if (v.kind !== "particles") return;
    this.camera.position.fromArray(v.position);
    this.camera.up.fromArray(v.up);
    this.controls.target.fromArray(v.target);
    this.camera.top = v.top;
    this.camera.bottom = v.bottom;
    const half = (v.top - v.bottom) / 2;
    this.camera.left = (-half * this.width) / this.height;
    this.camera.right = (half * this.width) / this.height;
    this.camera.zoom = v.zoom;
    this.camera.near = v.near;
    this.camera.far = v.far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }
  captureCanvas() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
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
    this.setFieldView(null, "particles");
    this.fieldPlane.geometry.dispose();
    this.fieldMaterial.dispose();
    this.fieldTexture.dispose();
    this.licTexture.dispose();
    this.velocityTexture.dispose();
    this.setTrace([], 0);
    this.setMaterial(null, [], 0, false);
    this.setProbes([]);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
