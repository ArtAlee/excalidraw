import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

const ExcalidrawApp = lazy(() => import("./App"));

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
const selfHosted = import.meta.env.VITE_APP_SELF_HOSTED === "true";
const WorkspaceApp = lazy(() => import("./workspace/WorkspaceApp"));
if (selfHosted) {
  const ownerWindow = rootElement.ownerDocument.defaultView!;
  ownerWindow.EXCALIDRAW_ASSET_PATH = ownerWindow.location.origin;
}
if (!selfHosted) {
  registerSW();
}
root.render(
  <StrictMode>
    {selfHosted ? (
      <Suspense fallback={null}>
        <WorkspaceApp ownerDocument={rootElement.ownerDocument} />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <ExcalidrawApp />
      </Suspense>
    )}
  </StrictMode>,
);
