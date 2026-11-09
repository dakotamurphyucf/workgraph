import type { Ticket, WorkActionIntent } from "../read-model.types";

export type OfferedAction =
  | {
      readonly kind: "action";
      readonly method: "ticket.update" | "ticket.hold";
      readonly label: string;
      readonly holdReason: "set" | "clear" | null;
    }
  | { readonly kind: "checks"; readonly tab: "admission" | "completion"; readonly label: string };

/** Computed graph readiness is never ownership. Only explicit native changes can alter its inputs. */
export function offeredAction(intent: WorkActionIntent, ticket: Ticket): OfferedAction {
  if (intent.kind === "status")
    return intent.status === "done"
      ? { kind: "checks", tab: "completion", label: "Review completion checks" }
      : {
          kind: "action",
          method: "ticket.update",
          label: "Review lifecycle change",
          holdReason: null,
        };
  if (intent.target === "blocked")
    return {
      kind: "action",
      method: "ticket.hold",
      label: "Review adding a hold",
      holdReason: "set",
    };
  return ticket.hold === null
    ? { kind: "checks", tab: "admission", label: "Review readiness checks" }
    : { kind: "action", method: "ticket.hold", label: "Review lifting hold", holdReason: "clear" };
}
