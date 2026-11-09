import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Field, Panel, Select, Toolbar } from "../../../components/Primitives";
import { ContentViewer } from "../../../content";
import { failureText } from "../../connections/failure";
import { CapturedValues } from "../../connections/CapturedValues";
import { Icon } from "../../../components/Icon";
import * as d from "../../../core/protocol/decoders";
import type { ReadState } from "../../../core/state/read-slot";
import type { LocalEvidenceFeatureProps, PublicationJob, StageSnapshot } from "./types";
const defaultLength = () => {
  const result = d.positiveDecimal.decode(d.jsonString("4096"));
  if (!result.ok) throw new Error("Invalid constant inspection length.");
  return result.value;
};
function present<T>(read: ReadState<T>): T | null {
  return read.kind === "ready" ? read.value : null;
}
function ReadNotice<T>({ read }: { readonly read: ReadState<T> }) {
  if (read.kind === "unexpected_error") throw read.error;
  return read.kind === "loading" ? (
    <p role="status">Reading local evidence…</p>
  ) : read.kind === "failed" ? (
    <p role="alert">{failureText(read.failure)}</p>
  ) : null;
}
function Output({ props }: { readonly props: LocalEvidenceFeatureProps }) {
  const state = props.controller.get(),
    stage = present(state.stage),
    output = present(state.output);
  const [offset, setOffset] = useState("0"),
    [length, setLength] = useState("4096"),
    [mode, setMode] = useState<"range" | "retained_tail">("range");
  const source = useMemo(
    () =>
      output === null
        ? null
        : {
            key: `${output.directory}:${output.capture_digest}:${output.stream}:${output.offset}:${output.returned_bytes}`,
            label: `Retained ${output.stream}`,
            bytes: Uint8Array.from(atob(output.data_base64), (c) => c.charCodeAt(0)),
            completeness:
              output.omitted_retained_bytes === "0" && !output.truncated && output.eof
                ? ("complete" as const)
                : ("partial" as const),
            hints: { mime: "text/plain", filename: `${output.stream}.log` },
          },
    [output],
  );
  const parsedOffset = d.decimal.decode(d.jsonString(offset)),
    parsedLength = d.decimal.decode(d.jsonString(length));
  const valid =
    parsedOffset.ok &&
    parsedLength.ok &&
    BigInt(parsedLength.value) > 0n &&
    BigInt(parsedLength.value) <= 65536n;
  const downloadUrl = useMemo(
    () => (state.download.kind === "ready" ? URL.createObjectURL(state.download.blob) : null),
    [state.download],
  );
  useEffect(
    () => () => {
      if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );
  if (stage?.kind !== "finished") return null;
  return (
    <Panel title="Retained output">
      <Toolbar label="Output selection">
        <Select
          label="Stream"
          value={state.selectedStream}
          onChange={(event) => {
            const stream = event.currentTarget.value;
            if (stream === "stdout" || stream === "stderr")
              void props.controller.inspectOutput(stream, {
                kind: "retained_tail",
                length: defaultLength(),
              });
          }}
        >
          <option value="stdout">Standard output</option>
          <option value="stderr">Standard error</option>
        </Select>
        <Select
          label="Byte selection"
          value={mode}
          onChange={(event) =>
            setMode(event.currentTarget.value === "range" ? "range" : "retained_tail")
          }
        >
          <option value="range">Byte range</option>
          <option value="retained_tail">Tail of retained prefix</option>
        </Select>
        {mode === "range" && (
          <Field
            label="Byte offset"
            value={offset}
            onChange={(event) => setOffset(event.currentTarget.value)}
          />
        )}
        <Field
          label="Maximum bytes"
          hint="1–65,536 bytes per inspection"
          value={length}
          onChange={(event) => setLength(event.currentTarget.value)}
        />
        <Button
          disabled={!valid}
          onClick={() => {
            if (parsedOffset.ok && parsedLength.ok)
              void props.controller.inspectOutput(
                state.selectedStream,
                mode === "range"
                  ? { kind: mode, offset: parsedOffset.value, length: parsedLength.value }
                  : { kind: mode, length: parsedLength.value },
              );
          }}
        >
          Read output
        </Button>
      </Toolbar>
      <p className="wg-hint">
        {stage[state.selectedStream].size_bytes} retained of{" "}
        {stage[state.selectedStream].observed_bytes} observed bytes.{" "}
        {stage[state.selectedStream].truncated
          ? "Discarded suffix is unavailable; retained tail is not the final process tail."
          : "No retained bytes were discarded."}{" "}
        {!stage[state.selectedStream].eof &&
          "The pipe did not reach EOF; total process output is unknown."}
      </p>
      <ReadNotice read={state.output} />
      {output !== null && (
        <>
          <p>
            {output.offset}–{BigInt(output.offset) + BigInt(output.returned_bytes)} bytes ·{" "}
            {output.omitted_retained_bytes} retained bytes outside this range
          </p>
          {output.text_lossy && (
            <p role="status">
              Text contains replacement characters for invalid UTF-8. Raw bytes and downloads remain
              exact.
            </p>
          )}
          {source !== null && <ContentViewer source={source} />}
        </>
      )}
      <Toolbar label="Exact output download">
        <Button
          disabled={state.download.kind === "running"}
          onClick={() => void props.controller.download()}
        >
          Verify complete retained {state.selectedStream}
        </Button>
        {state.download.kind === "running" && (
          <>
            <span role="status">
              {state.download.received} / {state.download.total} bytes verified
            </span>
            <Button onClick={props.controller.cancelDownload}>Cancel download</Button>
          </>
        )}
        {state.download.kind === "ready" && downloadUrl !== null && (
          <a href={downloadUrl} download={state.download.filename}>
            Download verified bytes
          </a>
        )}
      </Toolbar>
      {state.download.kind === "failed" && <p role="alert">{state.download.message}</p>}
    </Panel>
  );
}
function Stage({
  snapshot,
  props,
}: {
  readonly snapshot: StageSnapshot;
  readonly props: LocalEvidenceFeatureProps;
}) {
  return (
    <Panel
      title={
        snapshot.kind === "finished" ? "Saved execution capture" : "No completion capture available"
      }
    >
      <Badge tone={snapshot.kind === "finished" ? "neutral" : "warning"}>
        {snapshot.kind === "finished"
          ? "Finished capture"
          : "No completion capture — completion unknown"}
      </Badge>
      <p>
        <code>{snapshot.directory}</code>
      </p>
      <p>
        Literal argument vector · working directory <code>{snapshot.command.cwd}</code>
      </p>
      <ol>
        {snapshot.command.argv.map((argument, index) => (
          <li key={index}>
            <code style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{argument}</code>
          </li>
        ))}
      </ol>
      <p className="wg-hint">
        This interface never executes commands. An exit status is recorded evidence, not a
        validation or approval.
      </p>
      {snapshot.kind !== "finished" && snapshot.publication_intent !== "absent" && (
        <Button onClick={() => void props.controller.inspectIntent()}>
          Inspect saved native intent
        </Button>
      )}
      {snapshot.kind === "finished" && (
        <>
          <p>
            Outcome:{" "}
            <strong>
              {snapshot.outcome.kind === "exited"
                ? `exit ${snapshot.outcome.code}`
                : snapshot.outcome.kind === "signaled"
                  ? `signal ${snapshot.outcome.signal}`
                  : snapshot.outcome.kind === "launch_failed"
                    ? `launch failed: ${snapshot.outcome.message}`
                    : "interrupted"}
            </strong>{" "}
            · elapsed {snapshot.elapsed_ms} ms
          </p>
          <p>
            {snapshot.capture.size_bytes} bytes of saved evidence. Source observations are bounded;
            they do not prove which files the command used.
          </p>
          <Toolbar label="Stage actions">
            <Button
              disabled={props.context === null || snapshot.publication_intent !== "absent"}
              onClick={() => {
                if (props.context !== null) props.controller.newPublication(props.context);
              }}
            >
              Prepare publication
            </Button>
            {snapshot.publication_intent !== "absent" && (
              <Button onClick={() => void props.controller.inspectIntent()}>
                Inspect saved native intent
              </Button>
            )}
            <Button
              disabled={snapshot.owner_token === null || snapshot.publication_intent !== "absent"}
              onClick={() => void props.controller.cleanup()}
            >
              Clean owned stage
            </Button>
          </Toolbar>
          <p className="wg-hint">
            Cleanup removes only the validated stage’s known files with its exact ownership token.
            Native locks and publication/unknown-entry checks may refuse it. Published resources are
            never deleted.
          </p>
        </>
      )}
    </Panel>
  );
}
function Job({
  job,
  props,
}: {
  readonly job: PublicationJob;
  readonly props: LocalEvidenceFeatureProps;
}) {
  const state = props.controller.get(),
    known =
      job.state.kind === "published"
        ? job.state
        : job.state.kind === "running"
          ? job.state.previous
          : null;
  const context = job.plan.kind === "ui_prepared" ? job.plan.context : null;
  return (
    <section className="wg-panel" aria-label={`Publication ${job.plan.intention_id}`}>
      <div className="wg-panel-body">
        <h3>
          {known !== null
            ? job.state.kind === "running"
              ? "Resource published · ticket link in progress"
              : "Resource published"
            : job.state.kind === "prepared_unsent"
              ? "Ready to publish"
              : job.state.kind === "running"
                ? "Publication in progress"
                : job.state.kind === "local_save_incomplete"
                  ? "Finish saving locally"
                  : job.state.kind === "outcome_unknown"
                    ? "Publication outcome unknown"
                    : "Publication not sent"}
        </h3>
        <p>
          {job.plan.connection.label} · original generation {job.plan.connection.generation} ·{" "}
          <code>{job.plan.directory}</code>
          {context !== null && (
            <>
              {" "}
              · captured writer <code>{context.writer.actor_id}</code>
              {context.writer.run_id !== null && (
                <>
                  {" "}
                  / run <code>{context.writer.run_id}</code>
                </>
              )}
            </>
          )}
        </p>
        {job.plan.kind === "operator_bound_external" && (
          <p>
            Operator-associated external intent. The original endpoint was not recorded; this chosen
            endpoint is an explicit assertion, not proven original identity.
          </p>
        )}
        {known !== null && (
          <p role="status">
            {job.state.kind === "running"
              ? "Ticket linking is still in progress. Inspect observes the same captured invocation."
              : known.link.kind === "not_requested"
                ? "No ticket link requested."
                : known.link.kind === "linked"
                  ? "Ticket link committed."
                  : known.link.kind === "rejected"
                    ? `Resource retained; ticket link rejected: ${known.link.problem.message}`
                    : "Resource retained; ticket link outcome unknown. Recover receipts or retry the exact link explicitly."}
          </p>
        )}
        {(job.state.kind === "outcome_unknown" ||
          job.state.kind === "local_save_incomplete" ||
          job.state.kind === "failed_unsent") && (
          <p role="status">{job.state.diagnostic.message}</p>
        )}
        {job.diagnostic !== null && <p role="status">{job.diagnostic.message}</p>}
        {state.uncertain.has(job.plan.intention_id) && (
          <p role="status">
            The action response was lost. Last saved observation is shown; inspect or recover before
            another send.
          </p>
        )}
        <Toolbar label={`Publication actions ${job.plan.intention_id}`}>
          {job.state.kind === "local_save_incomplete" && (
            <Button
              disabled={state.busy}
              onClick={() => void props.controller.finishSaving(job.plan.intention_id)}
            >
              Finish saving exact preparation
            </Button>
          )}
          <Button
            disabled={state.busy}
            onClick={() => void props.controller.act(job.plan.intention_id, "inspect")}
          >
            Inspect publication
          </Button>
          {job.state.kind === "prepared_unsent" && !state.uncertain.has(job.plan.intention_id) && (
            <Button
              tone="primary"
              disabled={state.busy}
              onClick={() => void props.controller.act(job.plan.intention_id, "start")}
            >
              Publish resource
            </Button>
          )}
          {(job.state.kind === "outcome_unknown" ||
            (job.state.kind !== "running" &&
              known !== null &&
              (known.link.kind === "unknown" || known.link.kind === "rejected"))) && (
            <Button
              disabled={state.busy}
              onClick={() => void props.controller.act(job.plan.intention_id, "retryExact")}
            >
              Retry exact saved intent
            </Button>
          )}
          {(job.state.kind === "outcome_unknown" ||
            (job.state.kind !== "running" && known !== null)) && (
            <Button
              disabled={state.busy}
              onClick={() => void props.controller.act(job.plan.intention_id, "recover")}
            >
              Recover receipts only
            </Button>
          )}
        </Toolbar>
        {state.observations.get(job.plan.intention_id)?.kind === "stopped" &&
          job.state.kind === "running" && (
            <p>
              Automatic read-only observation stopped; use Inspect publication. The native helper
              may still be running.
            </p>
          )}
      </div>
    </section>
  );
}
export function LocalEvidenceFeature(props: LocalEvidenceFeatureProps) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.get),
    draft = state.draft;
  useEffect(() => {
    void props.controller.loadSaved();
  }, [props.controller]);
  if (state.unexpected !== null) throw state.unexpected.error;
  const current = present(state.stage),
    external = present(state.intent),
    saved = present(state.saved);
  return (
    <section className="workflow-local-evidence" aria-label="Local execution evidence">
      <div className="workflow-intro">
        <Icon name="check" />
        <div>
          <h3>Bring test and command results into your workflow</h3>
          <p>
            Execution evidence is a saved record of a command run by your terminal or agent harness:
            its outcome and captured output. Inspect that record here, publish it as a resource, and
            optionally link it to a ticket. This page does not run commands or approve the work.
          </p>
        </div>
      </div>
      <ol className="workflow-steps">
        <li>
          <span>1</span>
          <div>
            <strong>Find a saved stage</strong>
            <p>
              A stage is the local folder where the execution helper saved a command and its
              results.
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Inspect the result</strong>
            <p>
              Check the exit status and output. Missing or truncated output stays clearly marked.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Publish evidence</strong>
            <p>
              Review the destination and explicitly publish. A linked ticket can then reference the
              result.
            </p>
          </div>
        </li>
      </ol>
      <Panel title="Open a saved execution stage">
        <p>
          Inspect an existing stage created by the external host or harness, publish its saved
          capture, or clean an owned finished stage. Commands are never run here.
        </p>
        <Toolbar label="Local stage selection">
          <Field
            label="Saved stage folder"
            value={state.directory}
            onChange={(event) => props.controller.setDirectory(event.currentTarget.value)}
            hint="An absolute folder path on the machine running Workgraph UI. Ask your harness for the stage path; this is not a workspace folder."
            placeholder="/absolute/path/to/existing-stage"
          />
          <Button onClick={() => void props.controller.inspectStage()}>Open stage</Button>
        </Toolbar>
        <ReadNotice read={state.stage} />
      </Panel>
      {state.notice !== null && (
        <p role="alert">
          {state.notice.kind === "message" ? (
            state.notice.message
          ) : (
            <>
              {failureText(state.notice.failure)}
              {state.notice.uncertain &&
                " The request may have taken effect. Keep the same identity; inspect before retrying."}
            </>
          )}
        </p>
      )}
      {current !== null && <Stage snapshot={current} props={props} />}
      <Output props={props} />
      <ReadNotice read={state.intent} />
      {external !== null && (
        <Panel title="Associate an external saved intent">
          <p>
            The saved file did not record its original daemon endpoint. Its existing actor,
            workspace, resource, guards and mutation identity remain immutable. Associating performs
            no network I/O; choosing the wrong daemon may publish there on a later explicit retry.
          </p>
          <p>
            Chosen association: {props.context?.connection.label ?? "no connection selected"} ·
            generation {props.context?.connection.generation ?? "unavailable"}
          </p>
          {props.context !== null && <CapturedValues value={external.request} />}
          <Button
            disabled={props.context === null || state.busy}
            onClick={() => {
              if (props.context !== null) void props.controller.associate(props.context.connection);
            }}
          >
            Associate saved intent with this endpoint
          </Button>
        </Panel>
      )}
      {draft?.kind === "editing" && (
        <Panel title="Review capture publication">
          <p>
            Original writer <code>{draft.context.writer.actor_id}</code> · workspace{" "}
            <code>{draft.context.workspace_id}</code> · {draft.connection.label} generation{" "}
            {draft.connection.generation}. Selecting another actor or workspace does not retarget
            this draft.
          </p>
          <Field
            label="Resource ID"
            value={draft.fields.resourceId}
            onChange={(event) => props.controller.edit({ resourceId: event.currentTarget.value })}
          />
          <Field
            label="Expected resource metadata revision"
            hint="Use 0 only when this exact resource is known to be absent."
            value={draft.fields.expectedRevision}
            onChange={(event) =>
              props.controller.edit({ expectedRevision: event.currentTarget.value })
            }
          />
          <Field
            label="Evidence resource title"
            value={draft.fields.title}
            onChange={(event) => props.controller.edit({ title: event.currentTarget.value })}
          />
          <Field
            label="Ticket ID to link (optional)"
            hint="Leave empty for no link. Entering a ticket explicitly requests a separate guarded link after publication."
            value={draft.fields.ticketId}
            onChange={(event) => props.controller.edit({ ticketId: event.currentTarget.value })}
          />
          <Button disabled={state.busy} onClick={() => void props.controller.review()}>
            Review publication
          </Button>
        </Panel>
      )}
      {draft?.kind === "captured" &&
        !state.jobs.some((job) => job.plan.intention_id === draft.plan.intention_id) && (
          <Panel title="Saved preparation response">
            <p>
              Exact intention <code>{draft.plan.intention_id}</code>. If the local save response was
              lost, finish saving the same input; a new identity will not replace it.
            </p>
            <Button
              disabled={state.busy || draft.pending}
              onClick={() => void props.controller.finishSaving()}
            >
              Finish saving exact preparation
            </Button>
            <Button
              disabled={state.busy}
              onClick={() => void props.controller.act(draft.plan.intention_id, "inspect")}
            >
              Inspect saved preparation
            </Button>
          </Panel>
        )}
      {state.jobs.map((job) => (
        <Job key={job.plan.intention_id} job={job} props={props} />
      ))}
      <Panel title="Saved local publications">
        <Button onClick={() => void props.controller.loadSaved()}>
          Refresh saved publications
        </Button>
        <ReadNotice read={state.saved} />
        {saved !== null && (
          <>
            <p>
              {saved.items.length} shown · {saved.total} retained intentions. Loading history never
              retries a publication.
            </p>
            {saved.items.map((summary) => (
              <div key={summary.plan.intention_id}>
                <code>{summary.plan.directory}</code> · {summary.state_kind.replaceAll("_", " ")} ·
                original {summary.plan.connection.label} generation{" "}
                {summary.plan.connection.generation}
                <Button
                  disabled={state.busy}
                  onClick={() => void props.controller.act(summary.plan.intention_id, "inspect")}
                >
                  Inspect {summary.plan.intention_id}
                </Button>
              </div>
            ))}
            {saved.next_offset !== null && (
              <Button
                onClick={() => void props.controller.loadSaved(saved.next_offset ?? undefined)}
              >
                Next saved publications
              </Button>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
