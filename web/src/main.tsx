import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// Feature-detect flexbox gap (no CSS @supports test exists for it) so older browsers get margins.
function detectFlexGap(): void {
  const probe = document.createElement("div");
  probe.style.display = "flex";
  probe.style.flexDirection = "column";
  probe.style.rowGap = "1px";
  probe.appendChild(document.createElement("div"));
  probe.appendChild(document.createElement("div"));
  document.body.appendChild(probe);
  const supported = probe.scrollHeight === 1;
  probe.remove();
  if (!supported) document.documentElement.classList.add("no-flex-gap");
}
detectFlexGap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
