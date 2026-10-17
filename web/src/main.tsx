import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(location.search).has("gpu-check")) {
  void import("./ComputeCheck").then(({ default: Check }) =>
    root.render(<Check />),
  );
} else root.render(<App />);
