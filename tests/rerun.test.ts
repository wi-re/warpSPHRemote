import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rerunDraft, rerunIssue, unsupportedOverrides } from "../web/src/rerun";
import { RunAgainButton } from "../web/src/RunAgainButton";
import {
  dimensionChoices,
  resolutionLimit,
  integratorChoices,
} from "../web/src/launchParameters";
const preset: any = {
  id: "sedov",
  dimension: 1,
  dimensions: [1, 2, 3],
  maxNx: 16384,
  maxNxByDimension: { 1: 16384, 2: 512, 3: 128 },
  schemes: ["CRKSPH"],
  variants: { default: {} },
};
const features = [
  "videoFromStart",
  "recordingEstimates",
  "diagnosticRecording",
];
const run: any = {
  id: "old",
  name: "Sedov",
  status: "completed",
  launch: {
    preset: "sedov",
    scheme: "CRKSPH",
    variant: "default",
    nx: 256,
    duration: 1,
    steps: 20,
    record: true,
    exportInterval: 0.1,
    exportEverySteps: 4,
    paused: true,
    measurements: true,
    diagnosticInterval: 0.05,
    video: { fps: 24, interval: 0.1, everySteps: 2 },
    configuration: {
      simulation: { dim: 2, integrationScheme: "rungeKutta4" },
      params: { E0: 2 },
      solver: { diffusionParams: { K: 0.2 } },
    },
  },
  lease: "must-not-copy",
  pid: 123,
};
test("run again preserves the requested configuration and recording choices in an independent draft", () => {
  const draft = rerunDraft(run, [preset], features);
  assert.deepEqual(draft.spec, run.launch);
  assert.equal(draft.name, "Sedov");
  assert.equal("lease" in draft.spec, false);
  draft.spec.configuration!.solver!.diffusionParams.K = 9;
  draft.spec.video!.fps = 60;
  assert.equal(run.launch.configuration.solver.diffusionParams.K, 0.2);
  assert.equal(run.launch.video.fps, 24);
});
test("run again explains unavailable cases, dimensions, capabilities and missing launch requests", () => {
  assert.match(
    rerunIssue({ ...run, launch: undefined }, [preset], features)!,
    /No saved/,
  );
  assert.match(rerunIssue(run, [], features)!, /unavailable/);
  assert.match(
    rerunIssue(run, [{ ...preset, dimensions: [1] }], features)!,
    /dimension/,
  );
  assert.match(
    rerunIssue(
      { ...run, launch: { ...run.launch, nx: 513 } },
      [preset],
      features,
    )!,
    /resolution/,
  );
  assert.match(rerunIssue(run, [preset], [])!, /video/);
  assert.match(
    rerunIssue({ ...run, status: "running" }, [preset], features)!,
    /finishes/,
  );
});
test("finished action is review-only and active runs have no rerun action", () => {
  let called = false;
  const props = {
    run,
    presets: [preset],
    features,
    busy: false,
    onRunAgain: () => {
      called = true;
    },
  };
  assert.match(
    renderToStaticMarkup(React.createElement(RunAgainButton, props)),
    /Run again/,
  );
  assert.equal(called, false);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(RunAgainButton, {
        ...props,
        run: { ...run, status: "running" },
      }),
    ),
    "",
  );
  assert.match(
    renderToStaticMarkup(
      React.createElement(RunAgainButton, {
        ...props,
        run: { ...run, launch: undefined },
      }),
    ),
    /disabled/,
  );
});
test("schema changes cannot silently discard saved nested overrides", () => {
  assert.deepEqual(
    unsupportedOverrides(
      {
        properties: {
          dim: {},
          old: { readOnly: true },
          nested: { type: "object", properties: { kept: {} } },
        },
      },
      { dim: 2, old: 4, nested: { kept: 1, missing: 2 } },
      "simulation",
    ),
    ["simulation.old", "simulation.nested.missing"],
  );
});
test("dimension and classic timestepper options follow the installed catalogue and enum", () => {
  assert.deepEqual(dimensionChoices(preset), [1, 2, 3]);
  assert.deepEqual(dimensionChoices({ ...preset, dimensions: undefined }), [1]);
  assert.equal(resolutionLimit(preset, 3), 128);
  assert.deepEqual(
    integratorChoices({
      enum: ["rungeKutta2", "rungeKutta4", "symplecticEuler", "bdf5", "custom"],
      default: "custom",
    }),
    ["rungeKutta2", "rungeKutta4", "symplecticEuler", "custom"],
  );
  assert.deepEqual(
    integratorChoices({ enum: ["rungeKutta2", "bdf5"] }, "bdf5"),
    ["rungeKutta2", "bdf5"],
  );
});

test("changing solver cannot silently retain an unsupported integrator", async () => {
  const { integratorIssue } = await import("../web/src/launchParameters");
  assert.match(
    integratorIssue(
      { enum: ["rungeKutta2", "rungeKutta4"] },
      "symplecticEuler",
    )!,
    /unavailable/,
  );
  assert.equal(
    integratorIssue({ enum: ["rungeKutta2"] }, "rungeKutta2"),
    undefined,
  );
  assert.equal(
    integratorIssue({ enum: ["rungeKutta2"] }, undefined),
    undefined,
  );
});
