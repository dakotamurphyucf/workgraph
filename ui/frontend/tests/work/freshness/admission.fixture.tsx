import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RequestFields } from "../../../src/features/discussions/requests/RequestFields";
import type { RequestsInput } from "../../../src/features/discussions/requests/types";
import { WorkbenchDestination } from "../../../src/features/work/WorkbenchDestination";
import { workbenchRoute } from "../../../src/features/work/destinations";
import { createProtocolProcessor } from "../../../src/core/protocol/worker";
import type { HttpClient, HttpRequest, HttpResult } from "../../../src/core/protocol/http";
import { context, decode, json } from "../actions-fixtures";
import * as d from "../../../src/core/protocol/decoders";
import "../../../src/styles/tokens.css";
import "../../../src/styles/components.css";

const processing = createProtocolProcessor();
type Pending = {
  readonly finish: (socket: string) => void;
  readonly reject: () => void;
  readonly fail: () => void;
  readonly signal: AbortSignal | undefined;
};
const pending: Pending[] = [];
const client: HttpClient = {
  processing,
  request<T>(request: HttpRequest<T>): Promise<HttpResult<T>> {
    if (request.method !== "GET" || request.path !== "/connections/local/generations/1")
      return Promise.reject(new Error("Editable children must not send before admission"));
    return new Promise((resolve, reject) => {
      pending.push({
        signal: request.signal,
        fail: () =>
          resolve({
            ok: false,
            failure: { kind: "network", message: "Retained profile unavailable" },
          }),
        finish: (socket) => {
          const value = request.codec.decode(
            json({ id: "local", generation: "1", label: "Captured", socket }),
          );
          if (!value.ok) throw new Error(value.issue.expected);
          resolve({ ok: true, data: value.value, httpStatus: 200 });
        },
        reject: () => reject(new Error("Obsolete transport rejected after cancellation")),
      });
    });
  },
};
const original = context(client);
let mounts = 0;
export function Editable({ counted }: { readonly counted: () => void }) {
  useEffect(() => {
    mounts++;
    counted();
  }, [counted]);
  return <h2>Editable original workbench</h2>;
}
const count = () => {
  document.querySelector("output")?.replaceChildren(String(mounts));
};
export function Fixture() {
  const [profile, setProfile] = useState(original.connection),
    [owner, setOwner] = useState(0),
    [question, setQuestion] = useState<RequestsInput>({
      method: "request.ask",
      body: "Who should receive this?",
      fields: {
        id: "",
        kind: "clarification",
        recipients: [],
        resolverId: "",
        priority: "",
        deadlineUnixMs: "",
        relatedIds: [],
        supersedesIds: [],
      },
      destination: { kind: "new", title: "", boardId: "", ticketId: "" },
    });
  const captured = {
    ...original,
    connection: profile,
    route: workbenchRoute(
      original.connection,
      decode(d.identifier, "demo"),
      decode(d.identifier, "target"),
    ),
  };
  return (
    <>
      <h1>Workbench admission controls</h1>
      <button
        onClick={() =>
          setProfile({
            ...original.connection,
            generation: decode(d.positiveDecimal, "2"),
            socket: "/tmp/other.sock",
          })
        }
      >
        Retarget current profile
      </button>
      <button onClick={() => setProfile(original.connection)}>
        Return original current profile
      </button>
      <button onClick={() => pending.at(-1)?.finish(original.connection.socket)}>
        Resolve latest original profile
      </button>
      <button
        onClick={() =>
          pending.find((request) => request.signal?.aborted)?.finish(original.connection.socket)
        }
      >
        Resolve obsolete profile
      </button>
      <button
        onClick={() =>
          pending
            .filter((request) => request.signal?.aborted)
            .at(-1)
            ?.reject()
        }
      >
        Reject obsolete profile
      </button>
      <button
        onClick={() => {
          setProfile({ ...original.connection, socket: "/tmp/reused-root.sock" });
          setOwner(owner + 1);
        }}
      >
        Reload with reused identity
      </button>
      <button onClick={() => pending.at(-1)?.finish("/tmp/reused-root.sock")}>
        Resolve reused identity
      </button>
      <button onClick={() => pending.at(-1)?.fail()}>Fail current lookup</button>
      <output aria-label="Editable mounts">{mounts}</output>
      <WorkbenchDestination
        key={owner}
        context={captured}
        render={() => <Editable counted={count} />}
      />
      <section aria-label="Unsent question fields">
        <RequestFields input={question} disabled={false} onChange={setQuestion} />
      </section>
    </>
  );
}
const element = document.getElementById("fixture");
if (element === null) throw new Error("Missing fixture root");
// Production fixture retains the StrictMode wrapper; explicit profile changes exercise owner cleanup.
createRoot(element).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
