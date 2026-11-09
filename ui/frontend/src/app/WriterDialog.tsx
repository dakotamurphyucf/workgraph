import { useState } from "react";
import { ActorAvatar } from "../components/ActorAvatar";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { Button, Field } from "../components/Primitives";
import { identifier, jsonString } from "../core/protocol/decoders";
import type { HttpClient } from "../core/protocol/http";
import type { ConnectionProfile } from "../core/protocol/types";
import { failureText } from "../features/connections/failure";
import { readKnownActors } from "../features/work/actor-choices";
import { validIdentifier } from "./navigation";
import type { WriterSelection } from "./types";
import { readWriterRuns, useWriterChoices } from "./writer-choices";
import "./writer-design.css";

export function WriterDialog({
  client,
  connection,
  workspaceId,
  writer,
  prompt,
  storageUnavailable = false,
  onSelect,
  onClose,
}: {
  readonly client: HttpClient;
  readonly connection: ConnectionProfile | undefined;
  readonly workspaceId: string | null;
  readonly writer: WriterSelection;
  readonly prompt?: string | undefined;
  readonly storageUnavailable?: boolean;
  readonly onSelect: (writer: WriterSelection) => void;
  readonly onClose: () => void;
}) {
  const [actor, setActor] = useState(writer.actorId ?? "");
  const [run, setRun] = useState(writer.runId ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [actorSearch, setActorSearch] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [otherActors, setOtherActors] = useState(false);
  const workspace = identifier.decode(jsonString(workspaceId ?? ""));
  const scope =
    connection && workspace.ok
      ? { connection, workspaceId: workspace.value, projectId: null }
      : undefined;
  const actors = useWriterChoices(client, scope, readKnownActors);
  const runs = useWriterChoices(client, scope, readWriterRuns);
  const selectedActor = actors.rows?.find((row) => row.actor_id === actor);
  const selectedRun = runs.rows?.find((row) => row.run_id === run);
  const matchingActors = actors.rows?.filter((row) =>
    `${row.actor_id} ${row.registration?.name ?? ""}`
      .toLocaleLowerCase()
      .includes(actorSearch.trim().toLocaleLowerCase()),
  );
  const matchingRuns = runs.rows?.filter(
    (row) =>
      (otherActors || actor === "" || row.actor_id === actor) &&
      `${row.run_id} ${row.objective} ${row.actor_id} ${row.status}`
        .toLocaleLowerCase()
        .includes(runSearch.trim().toLocaleLowerCase()),
  );
  const actorError =
    actor !== "" && !validIdentifier(actor)
      ? "Use 1–96 ASCII letters, digits, underscores or hyphens."
      : undefined;
  const runError =
    run !== "" && !validIdentifier(run)
      ? "Use a valid run identifier, or leave this field empty."
      : undefined;
  return (
    <Dialog title="Acting actor & run" onClose={onClose} wide>
      <form
        className="wr-writer"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!actorError && !runError) onSelect({ actorId: actor || null, runId: run || null });
        }}
      >
        <div className="wr-content">
          {prompt && (
            <p className="wr-notice" role="status">
              {prompt}
            </p>
          )}
          {storageUnavailable && (
            <p className="wr-notice">
              Browser storage is unavailable. This selection will last for this tab only.
            </p>
          )}
          <div className="wr-intro">
            <span>
              <Icon name="participants" />
            </span>
            <div>
              <h3>Choose who you are working as</h3>
              <p>
                An actor is the person or agent named on your actions. A run is an optional record
                of a particular work session. Choose either here before making new changes.
              </p>
            </div>
          </div>
          <div className="wr-context">
            <Icon name="connection" />
            <span>{connection?.label || connection?.id || "No daemon selected"}</span>
            <span className="wr-context-divider">/</span>
            <strong>{workspaceId || "No workspace selected"}</strong>
          </div>
          <div className="wr-guidance">
            <Icon name="settings" />
            <p>
              This is a local identity selector, not a sign-in. Choosing an actor does not grant
              ticket access or transfer ownership. Workgraph still checks each action’s rules.
            </p>
          </div>
          {!scope && (
            <p className="wr-notice">
              Choose a daemon and workspace to browse people, agents and runs. You can still enter
              known IDs here; their meaning is checked when an action uses them.
            </p>
          )}
          <div className="wr-columns">
            <section className="wr-section" data-kind="actor">
              <header>
                <span>
                  <Icon name="participants" />
                </span>
                <div>
                  <h3>1. Acting actor</h3>
                  <p>Whose name should be attached to new actions?</p>
                </div>
              </header>
              <div className="wr-section-body">
                <Field
                  label="Acting actor ID"
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  placeholder="No actor selected"
                  hint="Choose a person or agent below, or enter an exact ID. An empty field leaves no acting actor selected."
                  {...(submitted && actorError ? { error: actorError } : {})}
                  maxLength={96}
                  spellCheck={false}
                  autoComplete="off"
                />
                {actor !== "" && (
                  <Button tone="quiet" onClick={() => setActor("")}>
                    Clear acting actor
                  </Button>
                )}
                {scope && (
                  <div className="wr-directory">
                    <Field
                      label="Search actors"
                      value={actorSearch}
                      onChange={(e) => setActorSearch(e.target.value)}
                      placeholder="Find a person or agent…"
                    />
                    <div className="wr-choices" aria-label="Actor choices">
                      {matchingActors?.map((row) => (
                        <button
                          type="button"
                          className="wr-choice"
                          key={row.actor_id}
                          aria-pressed={actor === row.actor_id}
                          onClick={() => setActor(row.actor_id)}
                        >
                          <ActorAvatar actor={row.actor_id} />
                          <span>
                            <strong>{row.registration?.name || row.actor_id}</strong>
                            <small>{row.actor_id}</small>
                            <span className="wr-tag">
                              {row.registration
                                ? `${row.registration.kind === "person" ? "Person" : "Agent"}${row.registration.archived ? " · Archived" : ""}`
                                : "Observed identity · not registered"}
                            </span>
                          </span>
                          {actor === row.actor_id && <Icon name="check" />}
                        </button>
                      ))}
                      {matchingActors?.length === 0 && (
                        <p className="wr-empty">
                          {actors.rows?.length === 0
                            ? "No actors recorded yet. Enter a known ID above, or register one in Participants."
                            : "No matching actors. Try a different name or ID."}
                        </p>
                      )}
                    </div>
                    {actors.rows === undefined && actors.state?.kind !== "failed" && (
                      <p role="status" className="wr-empty">
                        Loading actors…
                      </p>
                    )}
                    {actors.state?.kind === "failed" && (
                      <p className="wr-notice" role="alert">
                        {failureText(actors.state.failure)} You can retry or enter an ID above.
                      </p>
                    )}
                    <Button tone="quiet" onClick={actors.refresh}>
                      Refresh actors
                    </Button>
                  </div>
                )}
              </div>
            </section>
            <section className="wr-section" data-kind="run">
              <header>
                <span>
                  <Icon name="activity" />
                </span>
                <div>
                  <h3>2. Run context</h3>
                  <p>Optional. Link new actions to an existing work run.</p>
                </div>
              </header>
              <div className="wr-section-body">
                <Field
                  label="Run ID (optional)"
                  value={run}
                  onChange={(e) => setRun(e.target.value)}
                  placeholder="No run selected"
                  hint="Leave empty when you do not need run context. Selecting a run does not register it, start an agent, or claim a ticket."
                  {...(submitted && runError ? { error: runError } : {})}
                  maxLength={96}
                  spellCheck={false}
                  autoComplete="off"
                />
                {run !== "" && (
                  <Button tone="quiet" onClick={() => setRun("")}>
                    Use no run
                  </Button>
                )}
                {scope && (
                  <div className="wr-directory">
                    <Field
                      label="Search runs"
                      value={runSearch}
                      onChange={(e) => setRunSearch(e.target.value)}
                      placeholder="Search ID, objective, actor or status…"
                    />
                    {actor !== "" && (
                      <label className="wr-check">
                        <input
                          type="checkbox"
                          checked={otherActors}
                          onChange={(e) => setOtherActors(e.target.checked)}
                        />
                        Show runs for other actors
                      </label>
                    )}
                    <div className="wr-choices" aria-label="Run choices">
                      {matchingRuns?.map((row) => (
                        <button
                          type="button"
                          className="wr-choice"
                          key={row.run_id}
                          aria-pressed={run === row.run_id}
                          onClick={() => setRun(row.run_id)}
                        >
                          <ActorAvatar actor={row.actor_id} />
                          <span>
                            <strong>{row.objective || row.run_id}</strong>
                            <small>
                              {row.run_id} · {row.actor_id}
                            </small>
                            <span className="wr-tag" data-status={row.status}>
                              {row.status}
                            </span>
                          </span>
                          {run === row.run_id && <Icon name="check" />}
                        </button>
                      ))}
                      {matchingRuns?.length === 0 && (
                        <p className="wr-empty">
                          {runs.rows?.length === 0
                            ? "No runs recorded yet. You can continue without one, or register a run in Participants."
                            : "No runs match these filters. Try another search or include runs for other actors."}
                        </p>
                      )}
                    </div>
                    {runs.rows === undefined && runs.state?.kind !== "failed" && (
                      <p role="status" className="wr-empty">
                        Loading runs…
                      </p>
                    )}
                    {runs.state?.kind === "failed" && (
                      <p className="wr-notice" role="alert">
                        {failureText(runs.state.failure)} You can retry or enter an ID above.
                      </p>
                    )}
                    <p className="wr-help">
                      {actor !== "" && !otherActors
                        ? "Showing runs recorded for the entered actor. "
                        : "Showing runs from this workspace. "}
                      Status is the last recorded state, not a live process check.
                    </p>
                    <Button tone="quiet" onClick={runs.refresh}>
                      Refresh runs
                    </Button>
                  </div>
                )}
              </div>
            </section>
          </div>
          {selectedRun && selectedRun.actor_id !== actor && (
            <div className="wr-notice wr-notice--attention" role="status">
              <Icon name="settings" />
              <p>
                This run belongs to <strong>{selectedRun.actor_id}</strong>
                {actor === ""
                  ? ", but no acting actor is selected."
                  : `, while you selected ${actor}.`}{" "}
                Actor and run selection are independent. Clear or change the run if this is
                unintended; actions may reject a mismatched identity.
              </p>
            </div>
          )}
          {run !== "" && !selectedRun && (
            <p className="wr-help">
              Run {run} has not been verified in these choices. An entered ID does not prove that
              the run exists or is usable for your next action.
            </p>
          )}
        </div>
        <footer className="wr-footer">
          <div className="wr-summary">
            <ActorAvatar actor={actor || null} />
            <div>
              <strong>
                {actor === "" ? "No acting actor" : selectedActor?.registration?.name || actor}
              </strong>
              <span>{run === "" ? "No run context" : `Run · ${run}`}</span>
              <small>
                Applies to new actions. Existing drafts, prepared requests and claims keep their
                original identity.
              </small>
            </div>
          </div>
          <div className="wg-form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button tone="primary" type="submit">
              Use selection
            </Button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
