import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicable,
  activeOverrides,
  type ParameterSchema,
} from "../web/src/ConfigurationFields";
test("case form filters inactive and derived overrides without serializing defaults", () => {
  const schema: ParameterSchema = {
    properties: {
      enabled: { type: "boolean", default: false },
      strength: { type: "number", "x-applies-when": { enabled: true } },
      derived: { type: "number", readOnly: true },
      onlyCRK: { type: "number", "x-supported-schemes": ["CRKSPH"] },
    },
  };
  assert.deepEqual(
    activeOverrides(
      schema,
      { enabled: false, strength: 2, derived: 99, onlyCRK: 1 },
      "GSPH",
    ),
    { enabled: false },
  );
  assert.deepEqual(
    activeOverrides(schema, { strength: 2 }, "CRKSPH", { enabled: true }),
    { strength: 2 },
  );
  assert.deepEqual(activeOverrides(schema, {}, "CRKSPH"), {});
  assert.equal(
    applicable(
      { "x-applies-when-any": [{ "solver.scheme": "A" }, { enabled: true }] },
      { enabled: false },
      "A",
    ),
    true,
  );
});
