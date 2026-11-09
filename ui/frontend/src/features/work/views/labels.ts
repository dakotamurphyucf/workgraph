export const STATUS_LABEL = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
} as const;
export const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  "0": "No priority",
  "1": "Urgent",
  "2": "High",
  "3": "Normal",
  "4": "Low",
};
