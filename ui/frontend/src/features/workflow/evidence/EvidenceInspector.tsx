import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import { CapturedValues } from "../../connections/CapturedValues";
import { LazyDetails } from "../../connections/shared";
import { failureText } from "../../connections/failure";
import { jsonField } from "../../../core/json";
import { READS } from "./commands";
import { EvidenceInputError, encoded } from "./model";
import { initialReadInputs, objectKind, paged, readParams, type ReadInputs } from "./reads";
import type { EvidenceFeatureProps, EvidenceRead } from "./types";
export function EvidenceInspector({ props }: { readonly props: EvidenceFeatureProps }) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get),
    [method, setMethod] = useState<EvidenceRead>("contract.list"),
    [inputs, setInputs] = useState(initialReadInputs),
    [source, setSource] = useState(""),
    [raw, setRaw] = useState(false),
    [issue, setIssue] = useState(""),
    [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null),
    [busy, setBusy] = useState(false),
    owner = useRef<AbortController | null>(null);
  useEffect(() => () => owner.current?.abort(), []);
  const begin = () => {
    owner.current?.abort();
    const next = new AbortController();
    owner.current = next;
    return next;
  };
  const cancel = () => {
    owner.current?.abort();
    setBusy(false);
  };
  const field = (name: keyof ReadInputs, label: string) => (
    <Field
      label={label}
      value={String(inputs[name])}
      onChange={(event) => setInputs({ ...inputs, [name]: event.currentTarget.value })}
    />
  );
  const inspect = async () => {
    const abort = begin();
    setIssue("");
    setBusy(true);
    try {
      const exact = raw
        ? source
        : await encoded(
            props.context.client.processing,
            readParams(method, props.context.route.workspaceId ?? "", props.ticketId, inputs),
            abort.signal,
          );
      if (!abort.signal.aborted) await props.controller.inspect(method, exact);
    } catch (error: unknown) {
      if (abort.signal.aborted) return;
      if (error instanceof EvidenceInputError) setIssue(error.message);
      else setUnexpected({ error });
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  if (unexpected !== null) throw unexpected.error;
  if (state.inspector.kind === "unexpected_error") throw state.inspector.error;
  const kind = objectKind(method);
  const page = state.inspector.kind === "ready" ? state.inspector.value.pagination : null;
  const complete = page === null ? undefined : jsonField(page, "complete");
  const hasNext = page !== null && jsonField(page, "next_request")?.kind === "object";
  const hasRetry = page !== null && jsonField(page, "retry_request")?.kind === "object";
  return (
    <LazyDetails summary="Browse contracts, manifests, review records and external conditions">
      <p>
        Choose a record or read its history. Exact versions stay pinned; leaving a version blank
        explicitly reads its current head. Reads never apply changes.
      </p>
      <Select
        label="Record collection"
        value={method}
        onChange={(event) => {
          const next = READS.find((item) => item === event.currentTarget.value);
          if (next !== undefined) {
            cancel();
            setMethod(next);
            setRaw(false);
            setIssue("");
          }
        }}
      >
        {READS.map((item) => (
          <option key={item}>{item}</option>
        ))}
      </Select>
      {!raw && (
        <div className="ev-row">
          {kind !== null && field("objectId", `${kind} ID`)}
          {kind !== null &&
            kind !== "condition" &&
            method.endsWith(".get") &&
            field("version", "Exact object revision (blank reads current)")}
          {method === "acceptance.policy.get" && (
            <>
              <Select
                label="Policy scope"
                value={inputs.scopeKind}
                onChange={(event) =>
                  setInputs({
                    ...inputs,
                    scopeKind: event.currentTarget.value === "project" ? "project" : "ticket",
                  })
                }
              >
                <option value="ticket">Ticket</option>
                <option value="project">Project</option>
              </Select>
              {field("scopeId", "Scope ID (blank uses selected ticket only)")}
            </>
          )}
          {method === "validation.list" && (
            <>
              {field("manifestId", "Manifest filter ID (optional)")}
              {field("manifestRevision", "Exact manifest filter revision")}
            </>
          )}
          {method === "review.list" && field("reviewerId", "Reviewer filter ID (optional)")}
          {field("maxBytes", "Maximum response bytes (up to 1048576)")}
          {paged(method) && (
            <>
              {field("limit", "Records per page (up to 100)")}
              {field("offset", "Starting offset")}
              {field("revision", "Exact namespace revision (required after offset 0)")}
            </>
          )}
          {method === "reconciliation.list" && (
            <label>
              <input
                type="checkbox"
                checked={inputs.pendingOnly}
                onChange={(event) =>
                  setInputs({ ...inputs, pendingOnly: event.currentTarget.checked })
                }
              />
              Pending reconciliations only
            </label>
          )}
        </div>
      )}
      <details>
        <summary>Advanced exact selectors</summary>
        <label>
          <input
            type="checkbox"
            checked={raw}
            onChange={(event) => {
              const checked = event.currentTarget.checked,
                abort = begin();
              setRaw(checked);
              setBusy(checked);
              if (checked)
                void Promise.resolve()
                  .then(() =>
                    encoded(
                      props.context.client.processing,
                      readParams(
                        method,
                        props.context.route.workspaceId ?? "",
                        props.ticketId,
                        inputs,
                      ),
                      abort.signal,
                    ),
                  )
                  .then((value) => {
                    if (!abort.signal.aborted) setSource(value);
                  })
                  .catch((error: unknown) => {
                    if (abort.signal.aborted) return;
                    if (error instanceof EvidenceInputError) setIssue(error.message);
                    else setUnexpected({ error });
                  })
                  .finally(() => {
                    if (!abort.signal.aborted) setBusy(false);
                  });
            }}
          />
          Use raw lossless selector source
        </label>
        {raw && (
          <label className="ev-source-label">
            Exact read selectors
            <textarea
              aria-label="Exact read selectors"
              value={source}
              spellCheck={false}
              onChange={(event) => {
                cancel();
                setSource(event.currentTarget.value);
              }}
            />
          </label>
        )}
      </details>
      <Button disabled={busy} onClick={() => void inspect()}>
        {busy ? "Reading…" : "Read selected records"}
      </Button>
      {issue !== "" && (
        <p role="alert" className="wg-error">
          {issue}
        </p>
      )}
      {state.inspector.kind === "failed" && (
        <p role="alert" className="wg-error">
          {failureText(state.inspector.failure)}
        </p>
      )}
      {state.inspector.kind === "loading" && <p role="status">Reading exact evidence selectors…</p>}
      {state.inspector.kind === "ready" && (
        <>
          <CapturedValues value={state.inspector.value.response.data} />
          {complete?.kind === "boolean" && !complete.value && (
            <p role="status">
              This is a partial result. Use the available page or retry controls to read more.
            </p>
          )}
          <Toolbar label="Evidence read continuation">
            <Button
              disabled={!hasNext}
              onClick={() => void props.controller.continueInspection("next_request")}
            >
              Next exact page
            </Button>
            <Button
              disabled={!hasRetry}
              onClick={() => void props.controller.continueInspection("retry_request")}
            >
              Retry exact page with native byte budget
            </Button>
          </Toolbar>
        </>
      )}
    </LazyDetails>
  );
}
