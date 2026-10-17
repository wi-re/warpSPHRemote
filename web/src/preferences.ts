export interface ViewerPreferences {
  theme: "dark" | "light";
  backend: "auto" | "webgpu" | "cpu";
  wrapPeriodic: boolean;
}
const key = "warpsph-viewer-preferences";
export function readPreferences(): ViewerPreferences {
  const defaults: ViewerPreferences = {
    theme: "dark",
    backend: "auto",
    wrapPeriodic: true,
  };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return defaults;
    return {
      theme: value.theme === "light" ? "light" : "dark",
      backend: ["auto", "webgpu", "cpu"].includes(value.backend)
        ? value.backend
        : "auto",
      wrapPeriodic:
        typeof value.wrapPeriodic === "boolean" ? value.wrapPeriodic : true,
    };
  } catch {
    return defaults;
  }
}
export function savePreferences(value: ViewerPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* still usable for this session */
  }
}
