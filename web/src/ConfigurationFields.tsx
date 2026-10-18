import { NumberControl } from "./NumberControl";
export interface ParameterSchema {
  type?: string | string[];
  properties?: Record<string, ParameterSchema>;
  default?: any;
  enum?: any[];
  const?: any;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  readOnly?: boolean;
  deprecated?: boolean;
  "x-derived-from"?: string;
  "x-group"?: string;
  "x-supported-schemes"?: string[];
  "x-applies-when"?: Record<string, unknown>;
  "x-applies-when-any"?: Record<string, unknown>[];
}
export function applicable(
  s: ParameterSchema,
  values: Record<string, any>,
  scheme: string,
) {
  if (s["x-supported-schemes"] && !s["x-supported-schemes"].includes(scheme))
    return false;
  const actual: Record<string, any> = { ...values, "solver.scheme": scheme };
  const match = (c: Record<string, unknown>) =>
    Object.entries(c).every(([k, v]) => actual[k] === v);
  return (
    (!s["x-applies-when"] || match(s["x-applies-when"])) &&
    (!s["x-applies-when-any"] || s["x-applies-when-any"].some(match))
  );
}
export function activeOverrides(
  schema: ParameterSchema,
  value: Record<string, any>,
  scheme: string,
  defaults: Record<string, any> = {},
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => {
        const s = schema.properties?.[k];
        return (
          s &&
          !s.readOnly &&
          !s["x-derived-from"] &&
          applicable(s, { ...defaults, ...value }, scheme)
        );
      })
      .map(([k, v]) => [
        k,
        schema.properties?.[k]?.type === "object"
          ? activeOverrides(schema.properties[k], v, scheme)
          : v,
      ]),
  );
}
export function schemaDefaults(schema: ParameterSchema): Record<string, any> {
  return Object.fromEntries(
    Object.entries(schema.properties || {}).map(([k, s]) => [k, s.default]),
  );
}
export function ConfigurationFields({
  schema,
  value,
  onChange,
  scheme,
  defaults = {},
}: {
  schema: ParameterSchema;
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
  scheme: string;
  defaults?: Record<string, any>;
}) {
  const groups = new Map<string, [string, ParameterSchema][]>();
  for (const [name, s] of Object.entries(schema.properties || {})) {
    if (
      s.const !== undefined ||
      s.deprecated ||
      !applicable(
        s,
        { ...schemaDefaults(schema), ...defaults, ...value },
        scheme,
      )
    )
      continue;
    const group = s["x-group"] || "Parameters";
    groups.set(group, [...(groups.get(group) || []), [name, s]]);
  }
  return (
    <>
      {[...groups].map(([group, fields]) => (
        <details
          key={group}
          className="control-disclosure parameter-group"
          open={groups.size === 1}
        >
          <summary>{group}</summary>
          <div className="configuration-fields">
            {fields.map(([name, s]) => {
              const nested = s.type === "object" && s.properties,
                enabled = Object.hasOwn(value, name),
                inherited =
                  defaults[name] !== undefined ? defaults[name] : s.default;
              if (nested)
                return (
                  <fieldset key={name}>
                    <legend>{name}</legend>
                    <ConfigurationFields
                      schema={s}
                      defaults={defaults[name] || {}}
                      value={value[name] || {}}
                      scheme={scheme}
                      onChange={(v) => {
                        const next = { ...value };
                        if (Object.keys(v).length) next[name] = v;
                        else delete next[name];
                        onChange(next);
                      }}
                    />
                  </fieldset>
                );
              return (
                <ParameterInput
                  key={name}
                  name={name}
                  schema={s}
                  enabled={enabled}
                  value={enabled ? value[name] : inherited}
                  onToggle={() => {
                    const next = { ...value };
                    if (enabled) delete next[name];
                    else
                      next[name] =
                        inherited ??
                        s.enum?.[0] ??
                        ((Array.isArray(s.type) ? s.type[0] : s.type) ===
                        "boolean"
                          ? false
                          : 0);
                    onChange(next);
                  }}
                  onChange={(v) => onChange({ ...value, [name]: v })}
                />
              );
            })}
          </div>
        </details>
      ))}
    </>
  );
}
function ParameterInput({
  name,
  schema: s,
  enabled,
  value,
  onChange,
  onToggle,
}: {
  name: string;
  schema: ParameterSchema;
  enabled: boolean;
  value: any;
  onChange: (v: any) => void;
  onToggle: () => void;
}) {
  const kind = Array.isArray(s.type)
    ? s.type.find((t) => t !== "null")
    : s.type;
  const readonly = !!s.readOnly || !!s["x-derived-from"];
  return (
    <div className="configuration-field">
      <label className="check-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={readonly}
          onChange={onToggle}
        />
        {name}
        {readonly ? " (derived)" : ""}
      </label>
      {s.enum ? (
        <select
          aria-label={name}
          disabled={!enabled || readonly}
          value={JSON.stringify(value)}
          onChange={(e) => onChange(JSON.parse(e.target.value))}
        >
          {s.enum.map((v, i) => (
            <option key={i} value={JSON.stringify(v)}>
              {v === null ? "Inherit" : String(v)}
            </option>
          ))}
        </select>
      ) : kind === "boolean" ? (
        <select
          aria-label={name}
          disabled={!enabled || readonly}
          value={String(value)}
          onChange={(e) =>
            onChange(
              e.target.value === "null" ? null : e.target.value === "true",
            )
          }
        >
          <option value="true">True</option>
          <option value="false">False</option>
          {Array.isArray(s.type) && s.type.includes("null") && (
            <option value="null">Inherit</option>
          )}
        </select>
      ) : ["object", "array"].includes(kind || "") ? (
        <JSONParameter
          name={name}
          value={value}
          disabled={!enabled || readonly}
          onChange={onChange}
        />
      ) : ["number", "integer"].includes(kind || "") &&
        !(Array.isArray(s.type) && s.type.includes("null")) ? (
        <NumberControl
          aria-label={name}
          disabled={!enabled || readonly}
          value={value ?? 0}
          onValueChange={onChange}
          step={kind === "integer" ? 1 : "any"}
          min={s.minimum ?? s.exclusiveMinimum}
          max={s.maximum ?? s.exclusiveMaximum}
          required
        />
      ) : (
        <input
          aria-label={name}
          disabled={!enabled || readonly}
          type={["number", "integer"].includes(kind || "") ? "number" : "text"}
          step={kind === "integer" ? 1 : "any"}
          min={s.minimum ?? s.exclusiveMinimum}
          max={s.maximum ?? s.exclusiveMaximum}
          value={value ?? ""}
          placeholder={value == null ? "Inherit" : ""}
          onChange={(e) =>
            onChange(
              e.target.value === "" &&
                Array.isArray(s.type) &&
                s.type.includes("null")
                ? null
                : ["number", "integer"].includes(kind || "")
                  ? +e.target.value
                  : e.target.value,
            )
          }
        />
      )}
      <small>
        {s.description}
        {s["x-derived-from"] ? " Derived from " + s["x-derived-from"] : ""}
      </small>
    </div>
  );
}
import { useEffect, useState } from "react";
function JSONParameter({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: any;
  disabled: boolean;
  onChange: (v: any) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value ?? null)),
    [error, setError] = useState("");
  useEffect(() => {
    setText(JSON.stringify(value ?? null));
    setError("");
  }, [value]);
  return (
    <>
      <textarea
        aria-label={name}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setError("");
            e.currentTarget.setCustomValidity("");
            onChange(v);
          } catch {
            setError("Enter valid JSON before continuing.");
            e.currentTarget.setCustomValidity(
              "Enter valid JSON before continuing.",
            );
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </>
  );
}
