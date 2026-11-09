import type { FeatureContext } from "../../../app/types";
import { Field } from "../../../components/Primitives";
import { RecipientPicker } from "../../discussions/RecipientPicker";
import type { ReferenceKind } from "../../discussions/reference-choices";
import { ReferencePicker } from "../../discussions/ReferencePicker";
import type { CustomTarget } from "./types";

export interface ConfigurationReferences {
  readonly context: FeatureContext;
  readonly target: CustomTarget;
}
/** Suggestions use the draft's endpoint; navigating never transfers its ownership. */
export function ScopeChoice({
  references,
  kind,
  value,
  label,
  onChange,
}: {
  readonly references?: ConfigurationReferences;
  readonly kind: ReferenceKind | "actor";
  readonly value: string;
  readonly label: string;
  readonly onChange: (id: string) => void;
}) {
  if (!references)
    return (
      <Field
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hint="Enter the existing record ID in this workspace."
      />
    );
  const { context, target } = references;
  if (kind === "actor")
    return (
      <RecipientPicker
        context={context}
        endpoint={{
          connectionId: target.connection.id,
          generation: target.connection.generation,
          workspaceId: target.workspaceId,
        }}
        label={label}
        value={value}
        onChange={onChange}
        disabled={context.connection.socket !== target.connection.socket}
      />
    );
  return (
    <ReferencePicker
      context={context}
      endpoint={{
        connectionId: target.connection.id,
        generation: target.connection.generation,
        workspaceId: target.workspaceId,
      }}
      kind={kind}
      label={label}
      value={value}
      onChange={onChange}
      disabled={context.connection.socket !== target.connection.socket}
    />
  );
}
