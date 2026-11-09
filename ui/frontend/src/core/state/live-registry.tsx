import { createContext, useContext, useEffect } from "react";
import type { ReadSlot } from "./read-slot";
/** Component-owned read projections join the visible feature's single scheduler.
 * Registration grants read refresh only; slots must independently opt in. */
export type LiveSlots = Set<Pick<ReadSlot<unknown>, "refresh">>;
export const LiveSlotsContext = createContext<LiveSlots | null>(null);
export function useLiveSlot(slot: Pick<ReadSlot<unknown>, "refresh">) {
  const slots = useContext(LiveSlotsContext);
  useEffect(() => {
    slots?.add(slot);
    return () => {
      slots?.delete(slot);
    };
  }, [slots, slot]);
}
