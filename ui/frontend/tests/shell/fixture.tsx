/** Explicit browser-only test composition. Not imported by the production entry or build. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, type FeatureContext } from "../../src/app/App";
import { createHttpClient } from "../../src/core/protocol/http";
import { Button, Field, Panel, Select, Toolbar } from "../../src/components/Primitives";
import { Inspector } from "../../src/components/ResizablePane";

export function FeatureFixture({ context }: { readonly context: FeatureContext }) {
  const [draft, setDraft] = useState("");
  const [inspector, setInspector] = useState(false);
  return (
    <div>
      <Panel
        title="Explicit test feature"
        actions={
          <Toolbar label="Content view controls">
            <Select label="Language override" defaultValue="auto">
              <option value="auto">Auto</option>
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </Select>
            <Button>Raw source</Button>
          </Toolbar>
        }
      >
        <p>Directory freshness: {context.profileState}</p>
        <p>Connection: {context.connection.id}</p>
        <Field
          label="Captured draft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          onClick={() => {
            setInspector(true);
          }}
        >
          Open inspector
        </Button>
      </Panel>
      {inspector && (
        <Inspector
          title="Full ticket title is retained in the reusable inspector"
          subtitle="Explicit synthetic test composition"
          onClose={() => {
            setInspector(false);
          }}
        >
          <p>Inspector content is supplied by its feature.</p>
        </Inspector>
      )}
    </div>
  );
}
const element = document.getElementById("root");
if (!element) throw new Error("Test root is missing.");
const capability = document
  .querySelector('meta[name="workgraph-capability"]')
  ?.getAttribute("content");
if (!capability) throw new Error("Test capability is missing.");
createRoot(element).render(
  <App
    client={createHttpClient({ origin: window.location.origin, capability })}
    renderFeature={(context) => <FeatureFixture context={context} />}
  />,
);
