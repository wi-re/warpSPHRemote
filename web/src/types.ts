import type { Domain } from "./spatial";
export type NumericArray = Float32Array | Int32Array | BigInt64Array;
export interface Field {
  name: string;
  components: number;
  dtype: string;
}
export interface Source {
  id: string;
  name: string;
  format: string;
  frames: number;
  times: number[];
  timeKind: "simulation" | "frame";
  dimension: 1 | 2 | 3;
  fields: Field[];
  bounds: number[][];
  identity: string;
  domain?: Domain;
  internalEnergyAvailable?: boolean;
  live?: boolean;
  liveConnected?: boolean;
  liveRevision?: number;
  liveStep?: number;
  initialFrame?: number;
  videoArmed?: { fps: number; interval: number; everySteps?: number };
  scheme?: string;
  kernel?: string;
  integrator?: string;
  dt?: number;
}
export interface Frame {
  index: number;
  step?: number;
  liveRevision?: number;
  time: number;
  arrays: Record<string, { data: NumericArray; shape: number[] }>;
  bytes: number;
  physicalBounds?: number[][];
  domain?: Domain;
}
export interface Diagnostic {
  index: number;
  time: number;
  particles: number;
  kineticEnergy: number | null;
  internalEnergy?: number | null;
  totalEnergy?: number | null;
  maxSpeed: number | null;
  meanDensity: number | null;
  totalMass?: number | null;
  totalVolume?: number | null;
  totalMomentum?: number | null;
  momentumX?: number | null;
  momentumY?: number | null;
  momentumZ?: number | null;
  meanPressure?: number | null;
  minDensity?: number | null;
  maxDensity?: number | null;
}
export type DiagnosticMetric =
  | "kineticEnergy"
  | "internalEnergy"
  | "totalEnergy"
  | "maxSpeed"
  | "meanDensity"
  | "totalMass"
  | "totalVolume"
  | "totalMomentum"
  | "momentumX"
  | "momentumY"
  | "momentumZ"
  | "meanPressure"
  | "minDensity"
  | "maxDensity";
export type Mapping = "magnitude" | "x" | "y" | "z";
export interface ViewOptions {
  wrapPeriodic: boolean;
  palette: string;
  mapping: Mapping;
  normalization: "linear" | "log" | "symlog" | "cyclic";
  colorPeriod: number; // 0 disables periodic color wrapping.
  range: "frame" | "fixed";
  min: number;
  max: number;
  size: number;
  physical: boolean;
  boundaries: boolean;
  ghosts: boolean;
  grid: boolean;
  background: "dark" | "light";
  clipAxis: number;
  clip: number;
}
export const initialOptions: ViewOptions = {
  wrapPeriodic: true,
  palette: "viridis",
  mapping: "magnitude",
  normalization: "linear",
  colorPeriod: 0,
  range: "frame",
  min: 0,
  max: 1,
  size: 1,
  physical: true,
  boundaries: true,
  ghosts: false,
  grid: true,
  background: "dark",
  clipAxis: -1,
  clip: 1,
};
