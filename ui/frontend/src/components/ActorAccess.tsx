import { createContext, useContext } from "react";
export interface ActorAccess {
  readonly actorId: string | null;
  /** Opens selection only. The original action is never replayed or submitted automatically. */
  readonly choose: () => void;
}
export const ActorAccessContext = createContext<ActorAccess | null>(null);
export function useActorAccess() {
  return useContext(ActorAccessContext);
}
/** Gate only new UI intentions; captured drafts retain their original actor. */
export function useActorGate() {
  const access = useActorAccess();
  return () => {
    if (access?.actorId === null) {
      access.choose();
      return false;
    }
    return true;
  };
}
