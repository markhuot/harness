import { createRoot } from "react-dom/client";
import { Root } from "./App";
import "./styles.css";
import "./app.css";

// Surface crashes with a stack in the main-process log (HARNESS_DEBUG / capture mode).
window.addEventListener("error", (e: ErrorEvent) => console.error(e.error?.stack ?? e.message));

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => console.error(String(error), info.componentStack),
}).render(<Root />);
