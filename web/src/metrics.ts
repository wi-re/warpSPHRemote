import type { DiagnosticMetric } from "./types";
export const metricDefinitions: Record<
  DiagnosticMetric,
  { label: string; formula: string }
> = {
  kineticEnergy: { label: "Kinetic energy", formula: "½ Σ m |v|²" },
  internalEnergy: { label: "Thermal energy", formula: "Σ m u" },
  totalEnergy: { label: "Total energy", formula: "Kinetic + thermal" },
  maxSpeed: { label: "Maximum speed", formula: "max |v|" },
  meanDensity: { label: "Mean density", formula: "Fluid particle mean" },
  totalMass: { label: "Total mass", formula: "Σ m" },
  totalVolume: { label: "Fluid volume", formula: "Σ m / ρ" },
  totalMomentum: { label: "Net momentum", formula: "|Σ m v|" },
  momentumX: { label: "Momentum X", formula: "Σ m vₓ" },
  momentumY: { label: "Momentum Y", formula: "Σ m vᵧ" },
  momentumZ: { label: "Momentum Z", formula: "Σ m v_z" },
  meanPressure: { label: "Mean pressure", formula: "Fluid particle mean" },
  minDensity: { label: "Minimum density", formula: "min ρ" },
  maxDensity: { label: "Maximum density", formula: "max ρ" },
};
export const defaultMetrics = (thermal: boolean): DiagnosticMetric[] =>
  thermal
    ? ["kineticEnergy", "internalEnergy", "totalEnergy", "totalMomentum"]
    : ["kineticEnergy", "maxSpeed", "meanDensity"];
export const sanitizeMetrics = (
  value: unknown,
): DiagnosticMetric[] | undefined =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (key): key is DiagnosticMetric =>
              typeof key === "string" && Object.hasOwn(metricDefinitions, key),
          ),
        ),
      ]
    : undefined;
