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
  dimension: 2 | 3;
  fields: Field[];
  bounds: number[][];
  identity: string;
  domain?: Domain;
  internalEnergyAvailable?: boolean;
}
export interface Frame {
  index: number;
  time: number;
  arrays: Record<string, { data: NumericArray; shape: number[] }>;
  bytes: number;
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
}
export type DiagnosticMetric =
  | "kineticEnergy"
  | "internalEnergy"
  | "totalEnergy"
  | "maxSpeed"
  | "meanDensity";
export type Mapping = "magnitude" | "x" | "y" | "z";
export interface ViewOptions {
  wrapPeriodic: boolean;
  palette: string;
  mapping: Mapping;
  normalization: "linear" | "log" | "symlog";
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
