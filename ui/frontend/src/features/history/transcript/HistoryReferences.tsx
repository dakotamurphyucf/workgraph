import type { ReactNode } from "react";
import type { FeatureContext } from "../../../app/types";
import { identifier, jsonString } from "../../../core/protocol/decoders";
import { ReferenceFields } from "../../discussions/ReferenceFields";
/** A retained form uses its original destination; suggestions cannot retarget it. */
export function HistoryReferences({
  context,
  target = context,
  children,
}: {
  readonly context: FeatureContext;
  readonly target?: FeatureContext;
  readonly children: ReactNode;
}) {
  const workspace = identifier.decode(jsonString(target.route.workspaceId ?? ""));
  return workspace.ok ? (
    <ReferenceFields
      context={context}
      endpoint={{
        connectionId: target.connection.id,
        generation: target.connection.generation,
        workspaceId: workspace.value,
      }}
    >
      {children}
    </ReferenceFields>
  ) : (
    <>{children}</>
  );
}
