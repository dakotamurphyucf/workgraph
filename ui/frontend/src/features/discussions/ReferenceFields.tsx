import { ActorAvatar } from "../../components/ActorAvatar";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { FeatureContext } from "../../app/types";
import { Button, Field } from "../../components/Primitives";
import { RecipientPicker } from "./RecipientPicker";
import { ReferencePicker } from "./ReferencePicker";
import type { ReferenceKind } from "./reference-choices";
import type { Endpoint } from "./threads/types";

interface ReferenceScope {
  readonly context: FeatureContext;
  readonly endpoint: Endpoint;
}
const Scope = createContext<ReferenceScope | null>(null);
/** The current UI connection is checked against the draft's original endpoint.
 * Directory reads never retarget a retained mutation after a workspace switch. */
export function ReferenceFields({
  context,
  endpoint,
  children,
}: ReferenceScope & { readonly children: ReactNode }) {
  return <Scope.Provider value={{ context, endpoint }}>{children}</Scope.Provider>;
}
export function ReferenceField({
  kind,
  label,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  readonly kind: ReferenceKind | "actor";
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly hint?: string;
}) {
  const scope = useContext(Scope);
  return (
    <>
      {scope === null ? (
        <Field
          label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : kind === "actor" ? (
        <RecipientPicker
          {...scope}
          label={label}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      ) : (
        <ReferencePicker
          {...scope}
          kind={kind}
          label={label}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {hint && <p className="wg-hint">{hint}</p>}
    </>
  );
}

/** Append a directory choice without requiring users to copy IDs into a list.
 * The text field also accepts pasted IDs and preserves their existing ordering. */
export function ActorListField({
  label,
  value,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const [candidate, setCandidate] = useState("");
  const ids = value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    <div className="dc-actor-list-field">
      <div className="dc-actor-chips" aria-label={label}>
        {ids.length === 0 && <p>No actors added yet.</p>}
        {ids.map((id, index) => (
          <span className="dc-actor-chip" key={`${id}:${index}`}>
            <ActorAvatar actor={id} />
            <span>{id}</span>
            <Button
              type="button"
              tone="quiet"
              disabled={disabled}
              aria-label={`Remove ${id} from ${label.toLowerCase()}`}
              onClick={() => onChange(ids.filter((_, position) => position !== index).join("\n"))}
            >
              ×
            </Button>
          </span>
        ))}
      </div>
      <ReferenceField
        kind="actor"
        label={`Add to ${label.toLowerCase()}`}
        value={candidate}
        disabled={disabled}
        onChange={setCandidate}
        hint="Choose a person or agent, then click Add actor. Use Edit IDs to paste several at once."
      />
      <Button
        type="button"
        tone="quiet"
        disabled={disabled || candidate.trim() === ""}
        onClick={() => {
          const id = candidate.trim();
          const ids = value
            .split(/\r?\n/u)
            .map((item) => item.trim())
            .filter(Boolean);
          if (id && !ids.includes(id)) onChange([...ids, id].join("\n"));
          setCandidate("");
        }}
      >
        Add actor to {label.toLowerCase()}
      </Button>
      <details className="dc-inline-options">
        <summary>Edit IDs for {label.toLowerCase()}</summary>
        <label className="wg-field">
          {label}
          <textarea
            aria-label={label}
            value={value}
            disabled={disabled}
            rows={3}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </details>
    </div>
  );
}
