import type { IconName } from "../../components/Icon";
import type { ParticipantsPanel } from "./runs/types";
import type { CoordinationInput, CoordinationTab } from "./coordination/types";
export interface ViewGuide {
  readonly icon: IconName;
  readonly description: string;
  readonly example: string;
}
export const PANEL_GUIDES: Readonly<Record<ParticipantsPanel, ViewGuide>> = {
  runs: {
    icon: "activity",
    description:
      "A run is one working session of a person or agent. See its objective, recorded state, capabilities and associated history.",
    example:
      "Open a run to see its details. Registering a run records work already started by your agent or harness; it does not launch anything.",
  },
  actors: {
    icon: "participants",
    description:
      "People and agents are the identities that write to this workspace. An actor can have many runs and work on many tickets.",
    example:
      "This view combines registered identities with authors found in retained activity. Select an identity to inspect its work.",
  },
  catalog: {
    icon: "participants",
    description:
      "The actor catalog gives people and agents a display name and a kind. It is the workspace’s address book.",
    example:
      "Use Record a change to register or edit an identity. Archiving keeps its history; it is not an authentication or access-control switch.",
  },
  attempts: {
    icon: "work",
    description:
      "An attempt records one run’s work on a claimed ticket, including its checkpoints and final outcome.",
    example:
      "Filter by run or ticket to follow a particular piece of work. Finishing an attempt records evidence; it does not complete the ticket automatically.",
  },
  "actor-overview": {
    icon: "participants",
    description: "A focused view of work and coordination signals for one person or agent.",
    example:
      "Choose an actor in Views & filters. An optional run filter narrows the result to one working session.",
  },
  coordinator: {
    icon: "workflow",
    description:
      "A coordination summary for the selected workspace or project, helping you notice work that may need a decision.",
    example:
      "Use actor and run filters to focus on a worker. Signals describe recorded state, not live process health.",
  },
  actions: {
    icon: "connection",
    description:
      "Requests for a runner to respond when a parent run stops, such as asking a child run to wait or cancel.",
    example:
      "The runner performs the outside action. Acknowledging here records that it handled the request and saves the evidence.",
  },
  budget: {
    icon: "settings",
    description:
      "Limits for a selected run: total attempts, simultaneous attempts and reported usage thresholds.",
    example:
      "Choose a run in Views & filters. Attempt bounds control allocation; reported token and time thresholds produce attention signals, not process metering.",
  },
  "budget-attention": {
    icon: "activity",
    description: "Runs whose reported usage or allocation limits need attention.",
    example:
      "These signals use information reported to Workgraph. Missing reports can make usage incomplete; the UI does not measure agent processes.",
  },
  heartbeat: {
    icon: "activity",
    description:
      "The latest advisory observation recorded for a selected run, including whether that observation was persisted.",
    example:
      "Choose a run in Views & filters. A heartbeat does not renew a claim or reservation and does not prove the process is still alive.",
  },
};
export const TAB_ICONS: Readonly<Record<CoordinationTab, IconName>> = {
  records: "participants",
  allocation: "settings",
  reservations: "connection",
  conditions: "milestone",
  recovery: "history",
};
export const COORDINATION_GUIDES: Readonly<
  Record<Exclude<CoordinationTab, "records">, readonly [string, string, string]>
> = {
  allocation: [
    "Choose who can work",
    "A pool limits how much work happens at once. Ticket eligibility specifies capabilities, allowed actors and pools. Path declarations identify files or folders the ticket needs.",
    "Example: create a pool named review with two slots, then attach it to review tickets so only two can be claimed at once.",
  ],
  reservations: [
    "Coordinate shared resources",
    "A reservation records which run holds a shared resource or logical file path. Exclusive holds prevent other holders; shared holds allow compatible readers.",
    "A timed lease records a deadline. Passing that deadline does not release ownership automatically. The holder must release it, or an operator must perform a verified recovery.",
  ],
  conditions: [
    "Wait for work outside Workgraph",
    "An outside condition describes a result a ticket depends on, such as a deployment or human approval. A verified signal records evidence that the specific requirement was met.",
    "Declare the condition and its exact artifact first. After the outside work happens, record a signal with supporting evidence. Workgraph does not perform that work for you.",
  ],
  recovery: [
    "Safely hand abandoned work back",
    "Recovery removes captured ownership after an operator confirms the previous owner has stopped or been isolated. Each record preserves who acted, why and the evidence.",
    "To recover a ticket, inspect its claim below. To recover a reservation, open its holder in Reservations. A quiet run or expired lease alone is not sufficient confirmation.",
  ],
};
export const ACTION_GUIDES: Readonly<Record<CoordinationInput["kind"], readonly [string, string]>> =
  {
    pool: [
      "Pool capacity",
      "A pool is a named limit on concurrent ticket claims. Saving sets its slot count. Tickets use a pool only when their eligibility policy names it; changing capacity does not launch or stop agents.",
    ],
    policy: [
      "Ticket eligibility",
      "Choose a ticket, then the capabilities, shared pools and actors required to claim it. Saving replaces this ticket’s entire allocation policy. Other readiness requirements still apply.",
    ],
    paths: [
      "Files and folders this ticket needs",
      "Declare logical paths and whether claims require matching reservations. These are coordination names, not locks enforced by the operating system. Saving replaces the declarations; existing claims or active attempts may need to be released first.",
    ],
    acquire: [
      "Resources to reserve",
      "Choose the owning run and the resources it needs. Exclusive means one holder; shared allows compatible holders. The batch succeeds together or is rejected together. A timed lease still needs an explicit release or recovery.",
    ],
    renew: [
      "Extend this timed lease",
      "Review the exact owner and lease captured from this row. Applying renews that timed lease without changing the owner. If someone changed the hold, refresh and review a new action.",
    ],
    release: [
      "Release this hold",
      "Applying releases the exact captured hold so another run can acquire it. It does not stop the owning process. Automatic holds borrowed by ticket claims are released through those claims instead.",
    ],
    waiter: [
      "Let others know you are waiting",
      "Record, refresh or close an advisory waiting note for a run. This helps people coordinate; it does not grant a reservation, create queue order or start an automatic retry.",
    ],
    "holder-note": [
      "Explain the current hold",
      "Add a note such as what the holder is doing or when it expects to release. The note can expire independently. Saving or clearing it does not renew or release ownership.",
    ],
    condition: [
      "Define the outside requirement",
      "Link a ticket to a specific external operation and exact artifact. A required condition blocks readiness until matching evidence is recorded. Saving changes the declaration; an older signal will not automatically satisfy a changed declaration.",
    ],
    signal: [
      "Record the verified result",
      "Record what actually happened and pin evidence for this exact condition revision. Applying can satisfy the matching requirement. It does not run the external operation or independently verify your evidence.",
    ],
    recover: [
      "Confirm and document recovery",
      "Confirm that the previous owner was stopped or isolated outside Workgraph, and explain why recovery is needed. Applying removes only the captured ownership. It neither stops a process nor treats lease expiry as proof that work ended.",
    ],
  };
