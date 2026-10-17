import test from "node:test";
import assert from "node:assert/strict";
import {
  fft,
  histogram,
  spatialSpectrum,
  scalarSamples,
} from "../web/src/sources/analysis";
import {
  parseViewLink,
  buildViewURL,
  sourcePreset,
} from "../web/src/viewPresets";
import { initialOptions, type Source } from "../web/src/types";
import { initialGrid, type GridData } from "../web/src/sources/grid";
import { reduceDiagnostic } from "../web/src/sources/core";
const close = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const grid = (w = 32, h = 32): GridData => ({
  index: 0,
  time: 0,
  width: w,
  height: h,
  bounds: [
    [0, 0],
    [1, 1],
  ],
  periodic: [true, true],
  values: Float32Array.from({ length: w * h }, (_, i) =>
    Math.sin((2 * Math.PI * 4 * ((i % w) + 0.5)) / w),
  ),
  velocity: new Float32Array(w * h * 2),
  coverage: new Float32Array(w * h).fill(1),
  velocityValid: new Uint8Array(w * h).fill(1),
  excluded: 0,
});
const spec = {
  kind: "fft2" as const,
  window: "none" as const,
  mask: "strict" as const,
  axis: "x" as const,
  slice: 0.5,
};
test("radix-2 FFT agrees with direct DFT for complex signals", () => {
  const re = Float64Array.from([1, 2, 4, -2, 0, 3, 7, -4]),
    im = Float64Array.from([2, 0, 1, -1, 0, 2, 0, 1]),
    a = re.slice(),
    b = im.slice();
  fft(a, b);
  for (let k = 0; k < 8; k++) {
    let r = 0,
      s = 0;
    for (let n = 0; n < 8; n++) {
      const t = (-2 * Math.PI * k * n) / 8;
      r += re[n] * Math.cos(t) - im[n] * Math.sin(t);
      s += re[n] * Math.sin(t) + im[n] * Math.cos(t);
    }
    close(a[k], r);
    close(b[k], s);
  }
});
test("spatial spectra recover physical frequencies and obey Parseval under padding", () => {
  for (const [w, h] of [
    [32, 32],
    [32, 21],
  ]) {
    const g = grid(w, h),
      out = spatialSpectrum(g, spec);
    close(out.totalPower, 0.5);
    close(
      out.power.reduce((a, b) => a + b, 0),
      0.5,
    );
    assert.equal(out.width, 32);
    assert.equal(out.height, 32);
  }
  const line = spatialSpectrum(grid(), { ...spec, kind: "fft1" });
  const peak = line.power.indexOf(Math.max(...line.power));
  close(line.frequency[peak], 4);
  close(line.totalPower, 0.5);
});
test("spectra expose masks, remove the finite mean and apply the specified window", () => {
  const g = grid();
  g.values[0] = NaN;
  assert.throws(() => spatialSpectrum(g, spec), /masked/);
  const masked = spatialSpectrum(g, { ...spec, mask: "zero" });
  assert.equal(masked.valid, 1023);
  assert.equal(masked.mask, "zero");
  const constant = grid();
  constant.values.fill(5);
  close(spatialSpectrum(constant, spec).totalPower, 0);
  assert.ok(
    spatialSpectrum(grid(), { ...spec, window: "hann" }).totalPower < 0.5,
  );
});
test("histograms preserve finite counts, bin endpoints and constant fields", () => {
  const h = histogram(Float32Array.from([0, 1, 1, 2, NaN, Infinity]), 8);
  assert.equal(h.valid, 4);
  assert.equal(h.excluded, 2);
  assert.equal(
    h.y.reduce((a, b) => a + b, 0),
    4,
  );
  assert.equal(h.y[0], 1);
  assert.equal(h.y.at(-1), 1);
  assert.equal(histogram(new Float32Array(12).fill(2), 16).valid, 12);
});
test("meta reductions use fluid-only mass-weighted momentum and preserve unavailable values", () => {
  const f = {
    positions: { data: new Float32Array(6), shape: [3, 2] },
    kinds: { data: Int32Array.from([0, 0, 1]), shape: [3] },
    velocities: {
      data: Float32Array.from([2, -1, -1, 1, 100, 100]),
      shape: [3, 2],
    },
    masses: { data: Float32Array.from([2, 4, 100]), shape: [3] },
    densities: { data: Float32Array.from([2, 4, 100]), shape: [3] },
    pressures: { data: Float32Array.from([3, 5, 100]), shape: [3] },
  };
  const d = reduceDiagnostic(f, 0, 0);
  close(d.totalMass!, 6);
  close(d.totalVolume!, 2);
  close(d.momentumX!, 0);
  close(d.momentumY!, 2);
  close(d.totalMomentum!, 2);
  close(d.meanPressure!, 4);
  assert.equal(d.momentumZ, null);
  assert.deepEqual(
    Array.from(scalarSamples(f, "velocities", "magnitude")).map((v) =>
      Number.isFinite(v) ? v : null,
    ),
    [Math.fround(Math.sqrt(5)), Math.fround(Math.sqrt(2)), null],
  );
});
const source: Source = {
  id: "demo-khh-crksph-256",
  name: "KHH",
  format: "Recorded demo",
  frames: 4,
  times: [0, 1, 2.6, 4],
  dimension: 2,
  timeKind: "simulation",
  identity: "UIDs",
  bounds: [
    [0, 0],
    [1, 1],
  ],
  fields: [
    { name: "velocities", components: 2, dtype: "f4" },
    { name: "densities", components: 1, dtype: "f4" },
  ],
  internalEnergyAvailable: true,
};
test("KHH defaults use t≈2.6 density on a diverging grid with equal energy metrics", () => {
  const p = sourcePreset(source);
  assert.equal(p.index, 2);
  assert.equal(p.field, "densities");
  assert.equal(p.options.palette, "coolwarm");
  assert.equal(p.view.mode, "grid");
  assert.deepEqual(p.metrics.slice(0, 3), [
    "kineticEnergy",
    "internalEnergy",
    "totalEnergy",
  ]);
});
test("share URLs round-trip view parameters and reject corrupt options", () => {
  const view = {
    mode: "grid" as const,
    flow: true,
    settings: {
      ...initialGrid,
      resolution: 128 as const,
      quantity: "vorticity" as const,
    },
    seeds: 8,
    seedMode: "regular" as const,
    lic: { steps: 16, seed: 7, contrast: 2 },
  };
  const url = buildViewURL(
      "https://fluids.dev/warpSPHRemote/",
      source,
      2,
      "velocities",
      { ...initialOptions, palette: "coolwarm" },
      view,
      ["totalEnergy", "totalMomentum"],
      "light",
    ),
    parsed = parseViewLink(new URL(url).search);
  assert.equal(parsed.demo, source.id);
  assert.equal(parsed.time, 2.6);
  assert.equal(parsed.view.settings?.quantity, "vorticity");
  assert.equal(parsed.view.settings?.resolution, 128);
  assert.equal(parsed.view.lic?.seed, 7);
  assert.equal(parsed.options.palette, "coolwarm");
  assert.deepEqual(parsed.metrics, ["totalEnergy", "totalMomentum"]);
  const bad = parseViewLink(
    "?palette=evil&resolution=999&coverage=NaN&lic=1&licSteps=4.5&noiseSeed=-1&metrics=unknown,totalMass,totalMass",
  );
  assert.equal(bad.options.palette, undefined);
  assert.equal(bad.view.settings, undefined);
  assert.equal(bad.view.lic?.steps, 16);
  assert.deepEqual(bad.metrics, ["totalMass"]);
});

test("URL overrides are partial, distinguish raw and derived quantities, and carry analysis controls", () => {
  const raw = parseViewLink(
    "?quantity=densities&resolution=512&lic=0&range=frame&streamSeeds=12&seedMode=picked&seedX=.2&seedY=.3&chart=spectrum&fft=fft1&window=none&mask=strict&axis=y&slice=.75",
  );
  assert.deepEqual(raw.view.settings, { resolution: 512, quantity: "field" });
  assert.ok(Object.hasOwn(raw.view, "lic"));
  assert.equal(raw.view.lic, undefined);
  assert.equal(raw.options.range, "frame");
  assert.deepEqual(raw.view.seed, [0.2, 0.3]);
  assert.equal(raw.chart, "spectrum");
  assert.equal(raw.analysis?.kind, "fft1");
  assert.equal(raw.analysis?.axis, "y");
  assert.equal(raw.analysis?.slice, 0.75);
  const color = parseViewLink("?colorPreset=pressure");
  assert.equal(color.field, "pressures");
  assert.equal(color.options.normalization, "symlog");
  assert.equal(color.options.palette, "coolwarm");
});
