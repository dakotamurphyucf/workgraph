import { useEffect, useState, useSyncExternalStore } from "react";
import type { FeatureContext } from "../../app/types";
import { Button, Field, Select } from "../../components/Primitives";
import { createReadSlot } from "../../core/state/read-slot";
import { failureText } from "../connections/failure";
import type { ParticipantRecord } from "../participants/runs/types";
import { readKnownActors } from "../work/actor-choices";
import { workScopeKey } from "../work/read-model";
import type { WorkScope } from "../work/read-model.types";
import type { Endpoint } from "./threads/types";

/** Read-only known participants, including actors observed without catalog registration.
 * Explicitly archived registrations are omitted from suggestions; manual IDs remain available.
 * Switching input modes never replaces the
 * selected recipient, changes the writer, or broadens a retained endpoint. */
export function RecipientPicker({
  context,
  endpoint,
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly context: FeatureContext;
  readonly endpoint: Endpoint;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [manual, setManual] = useState(false);
  const [slot] = useState(() => createReadSlot<readonly ParticipantRecord[]>());
  const state = useSyncExternalStore(slot.subscribe, slot.get);
  const scope: WorkScope = {
    connection: context.connection,
    workspaceId: endpoint.workspaceId,
    projectId: null,
  };
  const key = workScopeKey(scope);
  const matches =
    context.connection.id === endpoint.connectionId &&
    context.connection.generation === endpoint.generation &&
    context.route.workspaceId === endpoint.workspaceId;
  const load = () => {
    if (!matches || disabled) return;
    void slot
      .load(key, (signal) => readKnownActors(context.client, scope, signal))
      .catch(() => {
        // Unexpected failures remain in the slot and reach the feature boundary.
      });
  };
  useEffect(() => {
    if (!matches || disabled) return;
    load();
    return () => slot.clear();
    // This key includes socket, profile generation and workspace; projects do not constrain actors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, key, context.client, matches, disabled]);
  if (state.kind === "unexpected_error") throw state.error;
  const rows =
    matches && state.kind !== "idle" && state.key === key
      ? state.kind === "ready"
        ? state.value
        : state.previous
      : undefined;
  const actors = (rows ?? []).filter((actor) => actor.registration?.archived !== true);
  return (
    <div className="dc-actor-picker">
      <div className="dc-input-mode" role="group" aria-label={`${label} input mode`}>
        <Button
          type="button"
          tone="quiet"
          disabled={disabled || !matches}
          aria-pressed={!manual}
          onClick={() => {
            setManual(false);
            load();
          }}
        >
          Choose actor
        </Button>
        <Button
          type="button"
          tone="quiet"
          disabled={disabled}
          aria-pressed={manual}
          onClick={() => setManual(true)}
        >
          Enter ID
        </Button>
      </div>
      {manual ? (
        <Field
          label={label}
          value={value}
          disabled={disabled}
          placeholder="e.g. review-agent"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Select
          label={label}
          value={value}
          disabled={disabled}
          onFocus={load}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a known actor…</option>
          {value !== "" && !actors.some((actor) => actor.actor_id === value) && (
            <option value={value}>{value} (entered ID)</option>
          )}
          {actors.map((actor) => (
            <option key={actor.actor_id} value={actor.actor_id}>
              {actor.registration?.name ?? actor.actor_id}
              {actor.registration?.name && actor.registration.name !== actor.actor_id
                ? ` · ${actor.actor_id}`
                : ""}
              {actor.registration === null ? " · seen in activity" : ""}
            </option>
          ))}
        </Select>
      )}
      {!matches ? (
        <p className="wg-hint">
          This link refers to an older connection. Enter the recipient ID directly; current
          workspace actors are not substituted.
        </p>
      ) : state.kind === "failed" ? (
        <p className="wg-hint" role="status">
          {failureText(state.failure)} You can enter an ID or{" "}
          <Button type="button" tone="quiet" onClick={load}>
            Retry actor list
          </Button>
          .
        </p>
      ) : (
        <p className="wg-hint">
          {disabled
            ? "This recipient is fixed for this saved view or action."
            : rows === undefined
              ? "Loading workspace actors… You can enter an ID now."
              : `${actors.length} known ${actors.length === 1 ? "actor" : "actors"} in this workspace, from the actor directory and recorded activity. Enter an ID for someone not listed.`}
        </p>
      )}
    </div>
  );
}
