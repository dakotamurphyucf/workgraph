import type { GraphRelation } from "./types";
export const RELATION_LABEL: Readonly<Record<GraphRelation["kind"], string>> = {
  prerequisite: "Prerequisite",
  inherited: "Inherited prerequisite",
  hierarchy: "Parent / child",
  related: "Related",
};
