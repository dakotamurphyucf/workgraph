import type { IconName } from "../../../components/Icon";
export interface Guide {
  readonly title: string;
  readonly icon: IconName;
  readonly description: string;
  readonly hint: string;
}
export const HISTORY_GUIDES: Readonly<Record<"sessions" | "search" | "usage" | "summary", Guide>> =
  {
    sessions: {
      title: "A readable record of the work",
      icon: "history",
      description:
        "Open a session to follow its conversations, tool calls and saved events. Sessions can hold any history—not only agent chats.",
      hint: "Open sessions accept new events. Archived sessions stay readable, but cannot be reopened. Neither state tells you whether an agent is running.",
    },
    search: {
      title: "Find a moment in recorded history",
      icon: "search",
      description:
        "Search the text that an importer saved for indexing, then open the matching event in its original session.",
      hint: "Search covers this workspace unless you choose a session. Events without searchable text still appear in their sessions.",
    },
    usage: {
      title: "Understand reported consumption",
      icon: "activity",
      description:
        "Compare saved token, time and custom usage reports by project, ticket, run or attempt. Choose filters, then refresh totals to apply them.",
      hint: "These are supplied reports, not a live meter or a bill. A run may span several sessions; its usage is not automatically divided between them.",
    },
    summary: {
      title: "Understand the selected session",
      icon: "list",
      description:
        "Inspect the events currently loaded from a session and any usage figures reported inside those events.",
      hint: "Select a session first. This is a window summary—not an AI-generated recap or a total for the entire conversation.",
    },
  };
