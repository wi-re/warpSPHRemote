import type { Preset } from "./companion";
import type { ParameterSchema } from "./ConfigurationFields";
export const classicIntegrators: Record<string, string> = {
  forwardEuler: "Forward Euler",
  explicitEuler: "Explicit Euler",
  rungeKutta2: "RK2 · midpoint",
  heunsMethod: "Heun · RK2",
  rungeKutta3: "RK3",
  rungeKutta4: "RK4",
  symplecticEuler: "Symplectic Euler",
  semiImplicitEuler: "Semi-implicit Euler",
  leapFrog: "Leapfrog",
  velocityVerlet: "Velocity Verlet",
  sspRK3: "SSP RK3",
};
export function dimensionChoices(p: Preset) {
  return p.dimensions ?? [p.dimension ?? 2];
}
export function resolutionLimit(p: Preset, dimension: number) {
  return p.maxNxByDimension?.[dimension] ?? p.maxNx ?? 512;
}
export function integratorChoices(
  schema?: ParameterSchema,
  selected?: string,
): string[] {
  return (schema?.enum ?? []).filter(
    (v): v is string =>
      typeof v === "string" &&
      (Object.hasOwn(classicIntegrators, v) ||
        v === schema?.default ||
        v === selected),
  );
}
export function withoutParameters(
  schema: ParameterSchema,
  names: string[],
): ParameterSchema {
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(
        ([k]) => !names.includes(k),
      ),
    ),
  };
}

export function integratorIssue(
  schema: ParameterSchema | undefined,
  selected: string | undefined,
): string | undefined {
  if (selected && schema?.enum && !schema.enum.includes(selected))
    return "The selected timestepper is unavailable with this solver. Choose a supported method or the case default.";
}
