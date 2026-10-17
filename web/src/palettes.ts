import { colormapTables } from "./colormap-tables";
// Perceptually ordered sequential maps plus explicit diverging/cyclic choices.
export const palettes: Record<
  string,
  { label: string; category: string; stops: string[] }
> = {
  viridis: {
    label: "Viridis",
    category: "Sequential",
    stops: [
      "#440154",
      "#482878",
      "#3e4989",
      "#31688e",
      "#26828e",
      "#1f9e89",
      "#35b779",
      "#6ece58",
      "#b5de2b",
      "#fde725",
    ],
  },
  magma: {
    label: "Magma",
    category: "Sequential",
    stops: [
      "#000004",
      "#1c1044",
      "#4f127b",
      "#812581",
      "#b5367a",
      "#e55063",
      "#fb8761",
      "#fec287",
      "#fcfdbf",
    ],
  },
  inferno: {
    label: "Inferno",
    category: "Sequential",
    stops: [
      "#000004",
      "#1b0c41",
      "#4a0c6b",
      "#781c6d",
      "#a52c60",
      "#cf4446",
      "#ed6925",
      "#fb9b06",
      "#f7d13d",
      "#fcffa4",
    ],
  },
  plasma: {
    label: "Plasma",
    category: "Sequential",
    stops: [
      "#0d0887",
      "#46039f",
      "#7201a8",
      "#9c179e",
      "#bd3786",
      "#d8576b",
      "#ed7953",
      "#fb9f3a",
      "#fdca26",
      "#f0f921",
    ],
  },
  cividis: {
    label: "Cividis",
    category: "Sequential",
    stops: [
      "#00224e",
      "#123570",
      "#3b496c",
      "#575d6d",
      "#707173",
      "#8a8678",
      "#a69c75",
      "#c3b369",
      "#e1cc55",
      "#fee838",
    ],
  },
  coolwarm: {
    label: "Cool / warm",
    category: "Diverging",
    stops: [
      "#3b4cc0",
      "#6788ee",
      "#9abbff",
      "#c9d7f0",
      "#dddddd",
      "#f2cbb7",
      "#f7a889",
      "#e7745b",
      "#b40426",
    ],
  },
  twilight: {
    label: "Twilight",
    category: "Cyclic",
    stops: [
      "#e2d9e2",
      "#9ebbc9",
      "#5b70a5",
      "#55467e",
      "#3c2147",
      "#301437",
      "#6f2953",
      "#a44c57",
      "#c7836b",
      "#d8b49c",
      "#e2d9e2",
    ],
  },
};
export function paletteBytes(name: string): Uint8Array {
  const table = colormapTables[name] ?? colormapTables.viridis;
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = table[i * 3 + c];
    data[i * 4 + 3] = 255;
  }
  return data;
}
export const gradient = (name: string) =>
  `linear-gradient(90deg,${(palettes[name] ?? palettes.viridis).stops.join(",")})`;
