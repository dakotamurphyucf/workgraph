import "./wait.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import * as d from "../../../../core/protocol/decoders";
import { requestWaitPlan } from "./client";
import { Button, Field, Toolbar } from "../../../../components/Primitives";
import type { Identifier } from "../../../../core/protocol/types";
import { failureText } from "../../../connections/failure";
import { sameEndpoint } from "../../threads/model";
import type { Endpoint } from "../../threads/types";
import { RequestBody } from "../RequestBody";
import type { RequestWaitController, RequestWaitObservation } from "./types";

function summary(value: RequestWaitObservation): string {
  switch (value.stop) {
    case "resolved":
      return value.request.answerBody === null
        ? "Resolved without an answer."
        : "Resolved with a pinned answer.";
    case "cancelled":
      return "The request was cancelled.";
    case "deadline":
      return "Wait deadline reached. The last complete observation was still open.";
    case "incomplete":
      return "Observation incomplete. Clipped data does not prove resolution.";
  }
}
/** Explicit, read-only foreground wait. Mounting never starts or retries it. */
export function RequestWaitPanel({
  controller,
  endpoint,
  requestId,
}: {
  readonly controller: RequestWaitController;
  readonly endpoint: Endpoint;
  readonly requestId: Identifier;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get),
    [timeoutMs, setTimeout] = useState("30000"),
    [pollIntervalMs, setPoll] = useState("1000"),
    [issue, setIssue] = useState<string | null>(null);
  useEffect(
    () => () => controller.stop(),
    [controller, endpoint.connectionId, endpoint.generation, endpoint.workspaceId, requestId],
  );
  const matches =
      state.kind !== "idle" &&
      sameEndpoint(state.plan, endpoint) &&
      state.plan.requestId === requestId,
    waiting = matches && state.kind === "waiting",
    observed = !matches ? null : state.kind === "stopped" ? state.observation : state.last;
  if (matches && state.kind === "unexpected_error") throw state.error;
  return (
    <section className="wg-panel" aria-label="Foreground request wait">
      <h4>Wait for resolution</h4>
      <p>Watch this request for a bounded time. Stopping the wait leaves the request unchanged.</p>
      <div className="wg-request-wait-fields">
        <Field
          label="Total milliseconds (1000–300000)"
          aria-label="Wait total milliseconds"
          inputMode="numeric"
          maxLength={6}
          value={timeoutMs}
          disabled={waiting}
          onChange={(event) => setTimeout(event.currentTarget.value)}
        />
        <Field
          label="Poll interval milliseconds (250–25000)"
          aria-label="Wait poll interval milliseconds"
          inputMode="numeric"
          maxLength={5}
          value={pollIntervalMs}
          disabled={waiting}
          onChange={(event) => setPoll(event.currentTarget.value)}
        />
      </div>
      <Toolbar label="Foreground request wait controls">
        <Button
          disabled={waiting}
          onClick={() => {
            const parsed = requestWaitPlan.decode(
              d.jsonObject([
                ["connectionId", d.jsonString(endpoint.connectionId)],
                ["generation", d.jsonString(endpoint.generation)],
                ["workspaceId", d.jsonString(endpoint.workspaceId)],
                ["requestId", d.jsonString(requestId)],
                ["timeoutMs", d.jsonString(timeoutMs)],
                ["pollIntervalMs", d.jsonString(pollIntervalMs)],
              ]),
            );
            if (!parsed.ok)
              setIssue(`Invalid wait ${parsed.issue.path.join(".")}: ${parsed.issue.expected}.`);
            else {
              setIssue(null);
              void controller.start(parsed.value);
            }
          }}
        >
          Start wait
        </Button>
        <Button disabled={!waiting} onClick={controller.stop}>
          Stop waiting
        </Button>
      </Toolbar>
      {issue !== null && <p role="alert">{issue}</p>}
      {waiting && <p role="status">Waiting for this captured request…</p>}
      {matches && state.kind === "cancelled_locally" && (
        <p role="status">Wait stopped locally. The request was not changed.</p>
      )}
      {matches && state.kind === "failed" && (
        <p role="alert">
          Wait stopped: {failureText(state.failure)} Start again explicitly when ready.
        </p>
      )}
      {observed !== null && (
        <>
          <p role="status">
            {observed === (state.kind === "stopped" ? state.observation : null)
              ? ""
              : "Previous completed wait: "}
            {summary(observed)}
          </p>
          {observed.request.answerBody !== null && (
            <>
              <p>Answer version {observed.request.answerBody.revision}, pinned at resolution.</p>
              <RequestBody
                body={observed.request.answerBody.body}
                identity={`wait:${endpoint.connectionId}:${endpoint.generation}:${observed.request.answerBody.id}:${observed.request.answerBody.revision}`}
                partial={observed.stop === "incomplete"}
              />
            </>
          )}
          <p className="wg-hint">
            Checked {observed.pollCount} times. Stopping this watch does not acknowledge or change
            the request.
          </p>
        </>
      )}
    </section>
  );
}
