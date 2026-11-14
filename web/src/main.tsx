import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme } from "./theme.js";
import { normalizeInitialLocation } from "./router.js";

// styles.css is linked from index.html (a side-effect CSS import would need an ambient module declaration).

normalizeInitialLocation();
applyTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
