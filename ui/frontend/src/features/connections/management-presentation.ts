import { createContext, useContext } from "react";

/** Presentation only: captured commands and recovery controls keep their original semantics. */
export const ManagementPresentation = createContext(false);
export function useManagementPresentation(): boolean {
  return useContext(ManagementPresentation);
}
