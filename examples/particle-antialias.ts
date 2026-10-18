/** Manual browser verification; see reports/PARTICLE_ANTIALIAS.md. */
import { ParticleRenderer } from "../web/src/renderer";
import { decodeFrame } from "../web/src/data";
import { initialOptions, type Frame, type Source } from "../web/src/types";

const host = document.querySelector<HTMLElement>("#scene")!;
const renderer = new ParticleRenderer(host);
const report = document.querySelector<HTMLPreElement>("#report")!;
const fixture = new URLSearchParams(location.search).get("fixture");
let metadata: Source, frame: Frame;
if (fixture) {
  metadata = await (await fetch(`${fixture}/metadata.json`)).json();
  frame = decodeFrame(
    await (await fetch(`${fixture}/frame.wpr1`)).arrayBuffer(),
  );
} else if (new URLSearchParams(location.search).get("demo") === "3d") {
  const n = 12 ** 3,
    p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[3 * i] = (i % 12) / 11;
    p[3 * i + 1] = (Math.floor(i / 12) % 12) / 11;
    p[3 * i + 2] = Math.floor(i / 144) / 11;
  }
  const scalar = (v: number) => ({
    data: new Float32Array(n).fill(v),
    shape: [n],
  });
  frame = {
    index: 0,
    time: 0,
    bytes: 0,
    arrays: {
      positions: { data: p, shape: [n, 3] },
      masses: scalar(0.001),
      densities: {
        data: Float32Array.from(
          { length: n },
          (_, i) => 0.125 + (0.875 * (i % 12)) / 11,
        ),
        shape: [n],
      },
      kinds: scalar(0),
    },
  };
  metadata = {
    id: "aa-3d",
    name: "Analytical 3D lattice",
    format: "Analytical demo",
    dimension: 3,
    fields: [{ name: "densities", components: 1, dtype: "float32" }],
    bounds: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    identity: "row",
    frames: 1,
    times: [0],
    timeKind: "simulation",
  };
} else {
  const nx = 800,
    ny = 160,
    n = nx * ny;
  const p = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    p[2 * i] = (((i % nx) + 0.5) / nx) * 14;
    p[2 * i + 1] = ((Math.floor(i / nx) + 0.5) / ny) * 6 - 3;
  }
  const scalar = (v: number) => ({
    data: new Float32Array(n).fill(v),
    shape: [n],
  });
  frame = {
    index: 0,
    time: 0,
    bytes: 0,
    arrays: {
      positions: { data: p, shape: [n, 2] },
      densities: scalar(1),
      masses: scalar((14 * 6) / n),
      kinds: scalar(0),
    },
  };
  metadata = {
    id: "aa-lattice",
    name: "Analytical lattice",
    format: "Analytical demo",
    dimension: 2,
    fields: [{ name: "densities", components: 1, dtype: "float32" }],
    bounds: [
      [0, -3],
      [14, 3],
    ],
    identity: "row",
    frames: 1,
    times: [0],
    timeKind: "simulation",
  };
}
renderer.setFrame(frame, metadata, "densities", {
  ...initialOptions,
  palette: "coolwarm",
  range: "fixed",
  min: 0.125,
  max: 1,
  grid: false,
});
report.textContent = `${metadata.name}: ${frame.arrays.positions.shape[0].toLocaleString()} particles`;
document.querySelector("#pan")!.addEventListener("click", () => {
  const dx =
    ((renderer.camera.right - renderer.camera.left) /
      renderer.width /
      renderer.camera.zoom) *
    0.25;
  renderer.camera.position.x += dx;
  renderer.controls.target.x += dx;
  renderer.controls.update();
  renderer.dirty = true;
});
document.querySelector("#zoom")!.addEventListener("click", () => {
  renderer.camera.zoom *= 2;
  renderer.camera.updateProjectionMatrix();
  renderer.dirty = true;
});
document.querySelector("#fit")!.addEventListener("click", () => {
  renderer.fit();
  report.textContent = `${metadata.name}: ${frame.arrays.positions.shape[0].toLocaleString()} particles`;
});

renderer.setPicking(true);
renderer.onPick = (index) => {
  report.textContent = `Picked row ${index}`;
};

// Exercise the actual fragment program on small white disks, comparing the sum
// of framebuffer coverage with the independent exact area πr² over subpixel pans.
document.querySelector("#checks")!.addEventListener("click", () => {
  const testHost = document.createElement("div");
  testHost.style.cssText = "width:32px;height:32px;position:fixed;left:0;top:0";
  document.body.appendChild(testHost);
  const test = new ParticleRenderer(testHost);
  const results = [];
  for (const pixelRatio of [1, 2]) {
    test.renderer.setPixelRatio(pixelRatio);
    test.material.uniforms.uPixelRatio.value = pixelRatio;
    test.renderer.setSize(32, 32);
    for (const radius of [0.1, 0.25, 0.5, 1, 1.5, 2, 4]) {
      const energies = [];
      for (const offset of [0, 0.125, 0.25, 0.375, 0.5]) {
        const one = (v: number) => ({
          data: new Float32Array([v]),
          shape: [1],
        });
        const f: Frame = {
          index: 0,
          time: 0,
          bytes: 0,
          arrays: {
            positions: { data: new Float32Array([offset, 0]), shape: [1, 2] },
            densities: one(1),
            masses: one((radius / 0.4) ** 2),
            kinds: one(0),
          },
        };
        test.setFrame(
          f,
          {
            ...metadata,
            id: "coverage-check",
            bounds: [
              [-16, -16],
              [16, 16],
            ],
            dimension: 2,
          },
          "densities",
          { ...initialOptions, grid: false },
        );
        test.texture.image.data.fill(255);
        test.texture.needsUpdate = true;
        test.renderer.setClearColor(0);
        Object.assign(test.camera, {
          left: -16,
          right: 16,
          top: 16,
          bottom: -16,
          zoom: 1,
        });
        test.camera.position.set(0, 0, 20);
        test.camera.up.set(0, 1, 0);
        test.camera.lookAt(0, 0, 0);
        test.camera.updateProjectionMatrix();
        test.controls.target.set(0, 0, 0);
        test.camera.updateMatrixWorld();
        test.renderer.render(test.scene, test.camera);
        const pixels = new Uint8Array((32 * pixelRatio) ** 2 * 4);
        const gl = test.renderer.getContext();
        gl.readPixels(
          0,
          0,
          32 * pixelRatio,
          32 * pixelRatio,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let energy = 0;
        for (let i = 0; i < pixels.length; i += 4) energy += pixels[i] / 255;
        energies.push(energy);
      }
      const expected = Math.PI * (radius * pixelRatio) ** 2,
        error = Math.max(...energies.map((e) => Math.abs(e - expected)));
      results.push({
        radius,
        pixelRatio,
        expected,
        energies,
        error,
        pass: error < 0.12,
      });
    }
  }
  const gl = test.renderer.getContext();
  report.textContent = JSON.stringify(
    {
      pass: results.every((r) => r.pass),
      device: gl.getParameter(gl.RENDERER),
      results,
    },
    null,
    2,
  );
  test.dispose();
  testHost.remove();
});
