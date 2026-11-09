import type { NavigationItem } from "../app/types";
export type IconName =
  | NavigationItem["icon"]
  | "check"
  | "archive"
  | "plus"
  | "board"
  | "list"
  | "filter"
  | "milestone"
  | "settings"
  | "search"
  | "chevron"
  | "close"
  | "menu"
  | "sun"
  | "moon"
  | "refresh"
  | "connection";
const paths: Record<IconName, string> = {
  check: "M5 12l4 4L19 6",
  plus: "M12 4v16 M4 12h16",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  work: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  workflow: "M3 3h6v6H3z M15 15h6v6h-6z M6 9v9h9 M9 6h9v9",
  discussions: "M4 4h16v12H9l-5 4z M8 8h8 M8 12h5",
  participants:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  history: "M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2",
  resources: "M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7",
  saved: "M6 3h12v18l-6-4-6 4z",
  facts: "M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  advanced: "M8 5l-5 7 5 7 M16 5l5 7-5 7 M14 3l-4 18",
  board: "M3 4h5v16H3z M10 4h5v11h-5z M17 4h4v14h-4z",
  list: "M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1",
  filter: "M3 5h18 M6 12h12 M10 19h4",
  milestone: "M5 21V3 M5 4c5-4 9 4 14 0v10c-5 4-9-4-14 0",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M16 16l5 5",
  chevron: "M9 5l7 7-7 7",
  close: "M6 6l12 12 M18 6L6 18",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1",
  moon: "M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 1 M18 18a8 8 0 0 1-13-1",
  connection: "M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4",
};
export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
