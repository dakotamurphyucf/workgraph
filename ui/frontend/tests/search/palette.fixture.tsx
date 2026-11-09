/** Isolated rendered lifetime control; native Search journeys use search.browser.ts. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CommandPalette } from "../../src/app/CommandPalette";
import { SearchFeature } from "../../src/features/search/SearchFeature";
import { createSearchStore } from "../../src/features/search/controller";
import { resourceRoute } from "../../src/features/knowledge/resources/navigation";
import type { HttpResult } from "../../src/core/protocol/http";
import type { Route } from "../../src/app/types";
import type { SearchClient } from "../../src/features/search/types";
import { capture, decode, wireHit, scope } from "./fixtures";
import { hitCodec } from "../../src/features/search/codecs";
import "../../src/styles/tokens.css";
import "../../src/styles/components.css";
import "../../src/styles/shell.css";
const source = decode(hitCodec, {
    ...wireHit,
    source: { kind: "resource_text", resource_id: "resource", revision: "1" },
  }),
  captured = { ...capture(), value: { ...capture().value, items: [source] } },
  pending: { resolve: (value: HttpResult<Route>) => void; reject: (error: Error) => void }[] = [];
const ok = <T,>(data: T): HttpResult<T> => ({ ok: true, data, httpStatus: 200 });
const client: SearchClient = {
  confirm: () => Promise.resolve(ok(scope.connection)),
  planning: () => Promise.resolve(ok(captured)),
  history: () => Promise.reject(new Error("Not used by this lifetime fixture")),
  resolve: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
};
const controller = createSearchStore(client, null);
function release(error = false) {
  const job = pending.shift();
  if (job === undefined) throw new Error("No pending open");
  if (error) job.reject(new Error("Late descriptor failure"));
  else
    job.resolve(
      ok(
        resourceRoute({
          connectionId: scope.connection.id,
          generation: scope.connection.generation,
          workspaceId: scope.workspaceId,
          resourceId: scope.workspaceId,
          content: { version: source.source.revision, expectedDigest: null },
        }),
      ),
    );
}
export function Fixture() {
  const [shown, setShown] = useState(false),
    [routes, setRoutes] = useState<readonly string[]>([]);
  return (
    <>
      <h1>Search lifetime fixture</h1>
      <button onClick={() => setShown(true)}>Open palette</button>
      <button onClick={() => release()}>Release success</button>
      <button onClick={() => release(true)}>Release failure</button>
      <output aria-label="Navigation count">{routes.length}</output>
      <output aria-label="Recent count">{controller.get().recent.length}</output>
      {shown && (
        <CommandPalette
          onClose={() => setShown(false)}
          onNavigate={() => {}}
          onConnections={() => {}}
          onWriter={() => {}}
          onScope={() => {}}
          renderSearch={(mode) => (
            <SearchFeature
              context={{
                connection: scope.connection,
                profiles: [scope.connection],
                route: {
                  view: "work",
                  connectionId: scope.connection.id,
                  workspaceId: scope.workspaceId,
                  projectId: null,
                  entityId: null,
                },
                navigate: (route) => setRoutes((previous) => [...previous, route.view]),
                onClose: () => setShown(false),
              }}
              controller={controller}
              mode={mode}
              footer={<button onClick={() => release()}>Release mounted success</button>}
            />
          )}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
