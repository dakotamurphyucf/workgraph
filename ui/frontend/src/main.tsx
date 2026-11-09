import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application, createApplicationServices } from "./application";
import { createHttpClient } from "./core/protocol/http";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Workgraph bootstrap root is missing.");
const root = createRoot(rootElement);
const capability = document
  .querySelector('meta[name="workgraph-capability"]')
  ?.getAttribute("content");
if (
  capability === undefined ||
  capability === null ||
  !/^[a-f0-9]{64}(?![\s\S])/u.test(capability)
) {
  root.render(
    <main>
      <h1>Open Workgraph through its companion</h1>
      <p>
        This page is missing its connection information. Open the address provided by workgraph-ui,
        or reload that page after restarting it.
      </p>
    </main>,
  );
} else {
  const client = createHttpClient({ origin: window.location.origin, capability });
  const services = createApplicationServices(client);
  // A persisted page can resume from browser history; only a final launch departure disposes workers.
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) services.dispose();
  });
  root.render(
    <StrictMode>
      <Application services={services} />
    </StrictMode>,
  );
}
