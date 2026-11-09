import { ReferenceField, ActorListField } from "../../discussions/ReferenceFields";
import { Icon } from "../../../components/Icon";
import { useId } from "react";
import { blankPath, blankPin } from "./form-inputs";
import { reservationLabel } from "./records";
import { Button, Field, Select, Toolbar } from "../../../components/Primitives";
import type {
  CoordinationInput,
  PathTargetInput,
  ProofPinInput,
  ReservationTargetInput,
} from "./types";

export function LongText({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="wg-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        rows={4}
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}
export function Strings({
  label,
  values,
  onChange,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <p className="wg-hint">
        {label === "Capabilities"
          ? "The claiming run must declare every capability listed here. Leave empty if no particular capabilities are required."
          : label === "Pools"
            ? "Each listed pool must have a free slot before this ticket can be claimed. Use names configured in Allocation rules → Pools."
            : "Add one value per row. Remove a row to leave it out of the replacement list."}
      </p>
      {values.map((value, index) => (
        <div className="wg-coord-row" key={index}>
          {label === "Pools" ? (
            <ReferenceField
              kind="pool"
              label={`Pool ${index + 1}`}
              value={value}
              onChange={(next) => onChange(values.map((old, i) => (i === index ? next : old)))}
            />
          ) : (
            <Field
              label={`${label} ${index + 1}`}
              value={value}
              onChange={(event) =>
                onChange(values.map((old, i) => (i === index ? event.currentTarget.value : old)))
              }
            />
          )}
          <Button
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button disabled={values.length >= 100} onClick={() => onChange([...values, ""])}>
        Add {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}
export function PathFields({
  value,
  onChange,
}: {
  readonly value: PathTargetInput;
  readonly onChange: (value: PathTargetInput) => void;
}) {
  return (
    <div className="wg-coord-grid">
      <Field
        label="Logical worktree"
        value={value.worktreeId}
        onChange={(event) => onChange({ ...value, worktreeId: event.currentTarget.value })}
      />
      <Select
        label="Path kind"
        value={value.kind}
        onChange={(event) => {
          const kind = event.currentTarget.value;
          if (kind === "file" || kind === "subtree") onChange({ ...value, kind });
        }}
      >
        <option value="file">File</option>
        <option value="subtree">Subtree</option>
      </Select>
      <Field
        label="Relative path"
        value={value.path}
        hint="Logical names only. No host filesystem enforcement or glob patterns."
        onChange={(event) => onChange({ ...value, path: event.currentTarget.value })}
      />
    </div>
  );
}
export function TargetFields({
  value,
  onChange,
}: {
  readonly value: ReservationTargetInput;
  readonly onChange: (value: ReservationTargetInput) => void;
}) {
  return (
    <>
      <Select
        label="Reservation kind"
        value={value.kind}
        onChange={(event) =>
          onChange(
            event.currentTarget.value === "named"
              ? { kind: "named", reservationId: "" }
              : { kind: "path", target: blankPath() },
          )
        }
      >
        <option value="named">Named resource</option>
        <option value="path">Logical path</option>
      </Select>
      {value.kind === "named" ? (
        <ReferenceField
          kind="reservation"
          label="Reservation ID"
          value={value.reservationId}
          onChange={(reservationId) => onChange({ ...value, reservationId })}
          hint="Choose an existing named resource or use Enter ID to name a new one."
        />
      ) : (
        <PathFields value={value.target} onChange={(target) => onChange({ ...value, target })} />
      )}
    </>
  );
}
const PIN_KINDS = [
  "resource",
  "event",
  "commit",
  "checksum",
  "comment",
  "amendment",
  "contract",
  "decision",
] as const;
export function PinFields({
  value,
  onChange,
}: {
  readonly value: ProofPinInput;
  readonly onChange: (value: ProofPinInput) => void;
}) {
  const field = (label: string, text: string, change: (text: string) => void) => (
    <Field label={label} value={text} onChange={(event) => change(event.currentTarget.value)} />
  );
  return (
    <fieldset>
      <legend>Exact artifact or record</legend>
      <p className="wg-hint">
        A pin identifies a particular version, not whichever version is newest. Choose the evidence
        type, then enter the matching identity and version.
      </p>
      <Select
        label="Proof kind"
        value={value.kind}
        onChange={(event) => {
          const kind = PIN_KINDS.find((k) => k === event.currentTarget.value);
          if (kind !== undefined) onChange(blankPin(kind));
        }}
      >
        {PIN_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </Select>
      {value.kind === "resource" ? (
        <>
          {field("Resource ID", value.resourceId, (resourceId) =>
            onChange({ ...value, resourceId }),
          )}
          {field("Content version", value.version, (version) => onChange({ ...value, version }))}
          {field("SHA-256 digest", value.digest, (digest) => onChange({ ...value, digest }))}
        </>
      ) : value.kind === "event" ? (
        <>
          {field("Session ID", value.sessionId, (sessionId) => onChange({ ...value, sessionId }))}
          {field("Event sequence", value.sequence, (sequence) => onChange({ ...value, sequence }))}
        </>
      ) : value.kind === "commit" ? (
        <>
          {field("Repository", value.repository, (repository) =>
            onChange({ ...value, repository }),
          )}
          {field("Commit object ID", value.objectId, (objectId) =>
            onChange({ ...value, objectId }),
          )}
        </>
      ) : value.kind === "checksum" ? (
        <>
          {field("Source", value.source, (source) => onChange({ ...value, source }))}
          {field("SHA-256 digest", value.digest, (digest) => onChange({ ...value, digest }))}
        </>
      ) : (
        <>
          {field(`${value.kind} ID`, value.id, (id) => onChange({ ...value, id }))}
          {field("Revision", value.revision, (revision) => onChange({ ...value, revision }))}
        </>
      )}
    </fieldset>
  );
}
export function Proofs({
  values,
  onChange,
}: {
  readonly values: readonly ProofPinInput[];
  readonly onChange: (values: readonly ProofPinInput[]) => void;
}) {
  return (
    <fieldset>
      <legend>
        <Icon name="check" /> Supporting evidence
      </legend>
      <p className="wg-hint">
        Attach exact records that support your explanation, such as a resource version, history
        event or commit. Removing a pin here does not delete its source.
      </p>
      {values.length === 0 && (
        <p className="pt-empty-inline">
          No evidence attached yet. Use Add proof to attach a record.
        </p>
      )}
      {values.map((value, index) => (
        <div key={index}>
          <PinFields
            value={value}
            onChange={(next) => onChange(values.map((old, i) => (i === index ? next : old)))}
          />
          <Button onClick={() => onChange(values.filter((_, i) => i !== index))}>
            Remove proof {index + 1}
          </Button>
        </div>
      ))}
      <Button disabled={values.length >= 100} onClick={() => onChange([...values, blankPin()])}>
        Add proof
      </Button>
    </fieldset>
  );
}
export function FormFields({
  input,
  onChange,
}: {
  readonly input: CoordinationInput;
  readonly onChange: (value: CoordinationInput) => void;
}) {
  const field = (label: string, value: string, change: (value: string) => void, hint?: string) => (
    <Field
      label={label}
      value={value}
      {...(hint === undefined ? {} : { hint })}
      onChange={(event) => change(event.currentTarget.value)}
    />
  );
  const reference = (
    kind: "ticket" | "run" | "reservation",
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => <ReferenceField kind={kind} label={label} value={value} onChange={onChange} />;
  switch (input.kind) {
    case "pool":
      return (
        <>
          {field("Pool name", input.name, (name) => onChange({ ...input, name }))}
          {field("Concurrent slots", input.limit, (limit) => onChange({ ...input, limit }))}
          <p className="wg-hint">
            Each allocated ticket uses one pool slot. Multiple attempts on that same ticket do not
            consume extra slots.
          </p>
          <p className="wg-hint">
            A pool limits simultaneous ticket allocation; it does not start or stop workers.
          </p>
        </>
      );
    case "policy":
      return (
        <>
          {reference("ticket", "Ticket ID", input.ticketId, (ticketId) =>
            onChange({ ...input, ticketId }),
          )}
          <h3 className="pt-form-heading">
            <Icon name="settings" /> Requirements for this ticket
          </h3>
          <Strings
            label="Capabilities"
            values={input.capabilities}
            onChange={(capabilities) => onChange({ ...input, capabilities })}
          />
          <Strings
            label="Pools"
            values={input.pools}
            onChange={(pools) => onChange({ ...input, pools })}
          />
          <h3 className="pt-form-heading">
            <Icon name="participants" /> Who may claim this ticket?
          </h3>
          <Select
            label="Eligible actors"
            value={input.actors.kind}
            onChange={(event) =>
              onChange({
                ...input,
                actors:
                  event.currentTarget.value === "allow"
                    ? { kind: "allow", ids: [] }
                    : { kind: "unrestricted" },
              })
            }
          >
            <option value="unrestricted">Any eligible actor</option>
            <option value="allow">Only named actors</option>
          </Select>
          {input.actors.kind === "allow" && (
            <ActorListField
              label="Allowed actors"
              value={input.actors.ids.join("\n")}
              disabled={false}
              onChange={(value) =>
                onChange({
                  ...input,
                  actors: { kind: "allow", ids: value.split(/\r?\n/u).filter(Boolean) },
                })
              }
            />
          )}
          <p className="wg-hint">
            Review replaces this ticket's complete allocation policy. An allowlist must contain at
            least one actor.
          </p>
        </>
      );
    case "paths":
      return (
        <>
          {reference("ticket", "Ticket ID", input.ticketId, (ticketId) =>
            onChange({ ...input, ticketId }),
          )}
          <label>
            <input
              type="checkbox"
              checked={input.requireReservations}
              onChange={(event) =>
                onChange({ ...input, requireReservations: event.currentTarget.checked })
              }
            />
            Require matching reservations for claims
          </label>
          {input.paths.map((row, index) => (
            <fieldset key={index}>
              <legend>
                <Icon name="resources" /> Path {index + 1}
              </legend>
              <PathFields
                value={row.target}
                onChange={(target) =>
                  onChange({
                    ...input,
                    paths: input.paths.map((old, i) => (i === index ? { ...old, target } : old)),
                  })
                }
              />
              <Select
                label={`Declaration ${index + 1} mode`}
                value={row.mode}
                onChange={(event) => {
                  const mode = event.currentTarget.value;
                  if (mode === "shared" || mode === "exclusive")
                    onChange({
                      ...input,
                      paths: input.paths.map((old, i) => (i === index ? { ...old, mode } : old)),
                    });
                }}
              >
                <option value="exclusive">Exclusive</option>
                <option value="shared">Shared</option>
              </Select>
              <Button
                onClick={() =>
                  onChange({ ...input, paths: input.paths.filter((_, i) => i !== index) })
                }
              >
                Remove declaration {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button
            onClick={() =>
              onChange({
                ...input,
                paths: [...input.paths, { target: blankPath(), mode: "exclusive" }],
              })
            }
          >
            Add path declaration
          </Button>
          <p className="wg-hint">
            Claims can borrow automatic path holds. Declaration changes require claims and
            nonterminal attempts to be released or recovered first.
          </p>
        </>
      );
    case "acquire": {
      const acquisition = input.acquisition;
      return (
        <>
          {reference("run", "Owning run ID", input.targetRunId, (targetRunId) =>
            onChange({ ...input, targetRunId }),
          )}
          <Select
            label="What do you want to reserve?"
            value={acquisition.kind}
            onChange={(event) =>
              onChange({
                ...input,
                acquisition:
                  event.currentTarget.value === "named"
                    ? { kind: "named", requests: [] }
                    : { kind: "paths", requests: [] },
              })
            }
          >
            <option value="named">Named resources</option>
            <option value="paths">Logical paths</option>
          </Select>
          {acquisition.kind === "named"
            ? acquisition.requests.map((row, index) => (
                <fieldset key={index}>
                  <legend>
                    <Icon name="connection" /> Resource {index + 1}
                  </legend>
                  {reference("reservation", "Reservation ID", row.reservationId, (reservationId) =>
                    onChange({
                      ...input,
                      acquisition: {
                        ...acquisition,
                        requests: acquisition.requests.map((old, i) =>
                          i === index ? { ...old, reservationId } : old,
                        ),
                      },
                    }),
                  )}
                  <Settings
                    value={row}
                    onChange={(next) =>
                      onChange({
                        ...input,
                        acquisition: {
                          ...acquisition,
                          requests: acquisition.requests.map((old, i) =>
                            i === index ? { ...old, ...next } : old,
                          ),
                        },
                      })
                    }
                  />
                  <Button
                    onClick={() =>
                      onChange({
                        ...input,
                        acquisition: {
                          ...acquisition,
                          requests: acquisition.requests.filter((_, i) => i !== index),
                        },
                      })
                    }
                  >
                    Remove request {index + 1}
                  </Button>
                </fieldset>
              ))
            : acquisition.requests.map((row, index) => (
                <fieldset key={index}>
                  <legend>
                    <Icon name="connection" /> Resource {index + 1}
                  </legend>
                  <PathFields
                    value={row.target}
                    onChange={(target) =>
                      onChange({
                        ...input,
                        acquisition: {
                          ...acquisition,
                          requests: acquisition.requests.map((old, i) =>
                            i === index ? { ...old, target } : old,
                          ),
                        },
                      })
                    }
                  />
                  <Settings
                    value={row}
                    onChange={(next) =>
                      onChange({
                        ...input,
                        acquisition: {
                          ...acquisition,
                          requests: acquisition.requests.map((old, i) =>
                            i === index ? { ...old, ...next } : old,
                          ),
                        },
                      })
                    }
                  />
                  <Button
                    onClick={() =>
                      onChange({
                        ...input,
                        acquisition: {
                          ...acquisition,
                          requests: acquisition.requests.filter((_, i) => i !== index),
                        },
                      })
                    }
                  >
                    Remove request {index + 1}
                  </Button>
                </fieldset>
              ))}
          <Button
            disabled={acquisition.requests.length >= 32}
            onClick={() =>
              onChange({
                ...input,
                acquisition:
                  acquisition.kind === "named"
                    ? {
                        kind: "named",
                        requests: [
                          ...acquisition.requests,
                          { reservationId: "", mode: "exclusive", durationMs: "" },
                        ],
                      }
                    : {
                        kind: "paths",
                        requests: [
                          ...acquisition.requests,
                          { target: blankPath(), mode: "exclusive", durationMs: "" },
                        ],
                      },
              })
            }
          >
            Add request
          </Button>
          <p className="wg-hint">
            The whole batch succeeds or fails together. Expiry is advisory and never frees an
            existing hold.
          </p>
        </>
      );
    }
    case "renew":
    case "release":
      return (
        <p>
          Use the captured original owner, token {input.fence.holder.token} and lease revision{" "}
          {input.fence.holder.lease.revision}. No newer ownership will be substituted.
        </p>
      );
    case "waiter":
      return (
        <>
          <TargetFields
            value={input.target}
            onChange={(target) => onChange({ ...input, target })}
          />
          {reference("run", "Waiting run ID", input.targetRunId, (targetRunId) =>
            onChange({ ...input, targetRunId }),
          )}
          <Select
            label="Waiter action"
            value={input.action.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value;
              if (kind === "close") onChange({ ...input, action: { kind, reason: "" } });
              else if (kind === "begin" || kind === "refresh")
                onChange({ ...input, action: { kind, durationMs: "30000", note: "" } });
            }}
          >
            <option value="begin">Begin advisory wait</option>
            <option value="refresh">Refresh advisory wait</option>
            <option value="close">Close advisory wait</option>
          </Select>
          {input.action.kind === "close" ? (
            field("Close reason", input.action.reason, (reason) =>
              onChange({ ...input, action: { kind: "close", reason } }),
            )
          ) : (
            <>
              {field("Waiter lifetime (ms)", input.action.durationMs, (durationMs) =>
                onChange({
                  ...input,
                  action: {
                    ...input.action,
                    kind: input.action.kind === "refresh" ? "refresh" : "begin",
                    durationMs,
                    note: input.action.kind === "close" ? "" : input.action.note,
                  },
                }),
              )}
              {field("Advisory note", input.action.note, (note) =>
                onChange({
                  ...input,
                  action: {
                    kind: input.action.kind === "refresh" ? "refresh" : "begin",
                    durationMs: input.action.kind === "close" ? "" : input.action.durationMs,
                    note,
                  },
                }),
              )}
            </>
          )}
          <p className="wg-hint">
            This records waiting; it creates no queue order, fairness promise or reservation grant.
            Review captures the stored waiter revision including inactive records.
          </p>
        </>
      );
    case "holder-note":
      return (
        <>
          {field(
            "Expected note revision",
            input.expectedRevision,
            (expectedRevision) => onChange({ ...input, expectedRevision }),
            "Use the actual stored note revision, or explicitly enter 0 for a new note. Expired or cleared notes can be hidden; missing is not proof of revision 0.",
          )}
          <Select
            label="Holder note action"
            value={input.action.kind}
            onChange={(event) =>
              onChange({
                ...input,
                action:
                  event.currentTarget.value === "clear"
                    ? { kind: "clear" }
                    : { kind: "set", durationMs: "30000", note: "", expectedReleaseUnixMs: "" },
              })
            }
          >
            <option value="set">Set advisory note</option>
            <option value="clear">Clear advisory note</option>
          </Select>
          {input.action.kind === "set" && (
            <>
              {field("Note lifetime (ms)", input.action.durationMs, (durationMs) =>
                onChange({
                  ...input,
                  action: {
                    kind: "set",
                    durationMs,
                    note: input.action.kind === "set" ? input.action.note : "",
                    expectedReleaseUnixMs:
                      input.action.kind === "set" ? input.action.expectedReleaseUnixMs : "",
                  },
                }),
              )}
              {field(
                "Expected release Unix ms (optional)",
                input.action.expectedReleaseUnixMs,
                (expectedReleaseUnixMs) =>
                  onChange({
                    ...input,
                    action: {
                      kind: "set",
                      expectedReleaseUnixMs,
                      durationMs: input.action.kind === "set" ? input.action.durationMs : "",
                      note: input.action.kind === "set" ? input.action.note : "",
                    },
                  }),
              )}
              {field("Advisory note", input.action.note, (note) =>
                onChange({
                  ...input,
                  action: {
                    kind: "set",
                    note,
                    durationMs: input.action.kind === "set" ? input.action.durationMs : "",
                    expectedReleaseUnixMs:
                      input.action.kind === "set" ? input.action.expectedReleaseUnixMs : "",
                  },
                }),
              )}
            </>
          )}
          <p className="wg-hint">
            Expected release is an observation only. This does not extend or release ownership.
          </p>
        </>
      );
    case "condition":
      return (
        <>
          {field("Condition ID", input.conditionId, (conditionId) =>
            onChange({ ...input, conditionId }),
          )}
          {reference("ticket", "Ticket ID", input.ticketId, (ticketId) =>
            onChange({ ...input, ticketId }),
          )}
          {field("External operation ID", input.operationId, (operationId) =>
            onChange({ ...input, operationId }),
          )}
          {field("Condition label", input.label, (label) => onChange({ ...input, label }))}
          <h3 className="pt-form-heading">
            <Icon name="resources" /> What result must match?
          </h3>
          <PinFields
            value={input.artifact}
            onChange={(artifact) => onChange({ ...input, artifact })}
          />
          <h3 className="pt-form-heading">
            <Icon name="participants" /> Notifications and readiness
          </h3>
          <ActorListField
            label="Recipients"
            value={input.recipients.join("\n")}
            disabled={false}
            onChange={(value) =>
              onChange({ ...input, recipients: value.split(/\r?\n/u).filter(Boolean) })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={input.required}
              onChange={(event) => onChange({ ...input, required: event.currentTarget.checked })}
            />
            Required for the ticket to become ready
          </label>
          <p className="wg-hint">
            Declare what outside work must be verified. Workgraph records proof; it does not perform
            that outside work.
          </p>
        </>
      );
    case "signal":
      return (
        <>
          <p>
            Signal exact condition {input.declaration.value.condition_id}, declaration revision{" "}
            {input.declaration.value.revision}, operation {input.declaration.value.operation_id}.
            Changing a declaration does not make an old signal satisfy it.
          </p>
          <Proofs
            values={input.evidence}
            onChange={(evidence) => onChange({ ...input, evidence })}
          />
          <LongText
            label="Verified result summary"
            value={input.summary}
            onChange={(summary) => onChange({ ...input, summary })}
          />
        </>
      );
    case "recover": {
      const recovery = input.recovery;
      return (
        <>
          {recovery.kind === "reservation" ? (
            <>
              <p>
                Recover {reservationLabel(recovery.fence.reservation.value.target)} from captured
                owner {recovery.fence.holder.actor_id} / {recovery.fence.holder.run_id}.
              </p>
              <p className="wg-hint">
                Reservation epoch {recovery.fence.reservation.value.epoch} · token{" "}
                {recovery.fence.holder.token} · lease epoch {recovery.fence.holder.lease.epoch} ·
                lease revision {recovery.fence.holder.lease.revision}
              </p>
            </>
          ) : (
            <>
              <p>
                Recover ticket {recovery.fence.ticketId} from captured owner{" "}
                {recovery.fence.actorId} / {recovery.fence.runId ?? "no run"}.
              </p>
              <p className="wg-hint">
                Ticket revision {recovery.fence.ticketRevision} · claim token {recovery.fence.token}{" "}
                · lease epoch {recovery.fence.lease.epoch} · lease revision{" "}
                {recovery.fence.lease.revision}
              </p>
            </>
          )}
          <Select
            label="Outside confirmation"
            value={recovery.confirmation}
            onChange={(event) => {
              const confirmation = event.currentTarget.value;
              if (confirmation === "" || confirmation === "stopped" || confirmation === "isolated")
                onChange({ ...input, recovery: { ...recovery, confirmation } });
            }}
          >
            <option value="">Choose actual confirmation</option>
            <option value="stopped">Previous owner was stopped</option>
            <option value="isolated">Previous owner was isolated</option>
          </Select>
          <LongText
            label="Recovery reason"
            value={recovery.reason}
            onChange={(reason) => onChange({ ...input, recovery: { ...recovery, reason } })}
          />
          <Proofs
            values={recovery.evidence}
            onChange={(evidence) => onChange({ ...input, recovery: { ...recovery, evidence } })}
          />
          {recovery.kind === "ticket" && (
            <Select
              label="Ticket disposition"
              value={recovery.disposition}
              onChange={(event) => {
                const disposition = event.currentTarget.value;
                if (disposition === "preserve_status" || disposition === "requeue")
                  onChange({ ...input, recovery: { ...recovery, disposition } });
              }}
            >
              <option value="preserve_status">Preserve status</option>
              <option value="requeue">Requeue</option>
            </Select>
          )}
          <p className="wg-hint">
            Recovery records your attributed outside confirmation. Lease expiry, a cancellation
            request or a quiet process record is not proof that the old owner stopped.
          </p>
        </>
      );
    }
  }
}
function Settings({
  value,
  onChange,
}: {
  readonly value: { readonly mode: "shared" | "exclusive"; readonly durationMs: string };
  readonly onChange: (value: {
    readonly mode: "shared" | "exclusive";
    readonly durationMs: string;
  }) => void;
}) {
  return (
    <Toolbar label="Reservation settings">
      <Select
        label="Reservation mode"
        value={value.mode}
        onChange={(event) => {
          const mode = event.currentTarget.value;
          if (mode === "shared" || mode === "exclusive") onChange({ ...value, mode });
        }}
      >
        <option value="exclusive">Exclusive</option>
        <option value="shared">Shared</option>
      </Select>
      <Field
        label="Lease duration (ms, optional)"
        value={value.durationMs}
        hint="Blank is indefinite; a timed lease still requires explicit release or recovery."
        onChange={(event) => onChange({ ...value, durationMs: event.currentTarget.value })}
      />
    </Toolbar>
  );
}
