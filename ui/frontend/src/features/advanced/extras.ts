import type { HostSurface } from "./types";
/** Host/offline surfaces are dispositions, never fabricated daemon method names. */
export const HOST_SURFACES: readonly HostSurface[] = Object.freeze([
  {
    name: "--version",
    summary: "Compare the executable version with the active daemon and UI.",
    command: "workgraph --version",
    guidance:
      "Runs on your host. Compare the reported API and release before using a different executable.",
    reference: "skills/workgraph/references/compatibility.md",
  },
  {
    name: "--help",
    summary: "Top-level command syntax and setup guidance.",
    command: "workgraph --help",
    guidance: "Offline executable help. The UI does not run shell commands.",
    reference: "skills/workgraph/SKILL.md",
  },
  {
    name: "capabilities",
    summary: "Browse the eight feature categories.",
    command: "workgraph capabilities",
    guidance:
      "Categories describe features; they do not grant actor permissions or run eligibility. Current categories are also shown in this explorer.",
    reference: "skills/workgraph/references/discovery/index.md",
  },
  {
    name: "discover",
    summary: "Search executable metadata by intent.",
    command: "workgraph discover 'find a useful operation' --output json",
    guidance:
      "Offline metadata search. For recorded workspace content use search.query; for imported history use history.search.",
    reference: "skills/workgraph/references/discovery/index.md",
  },
  {
    name: "methods",
    summary: "Inspect the executable method inventory and convenience tiers.",
    command: "workgraph methods --output json",
    guidance:
      "Every current method is selectable here. Core and advanced tiers describe convenience, not authority.",
    reference: "skills/workgraph/references/api/index.md",
  },
  {
    name: "help",
    summary: "Read executable guidance for methods, families, helpers or workflows.",
    command: "workgraph help ticket.create",
    guidance:
      "Select a method here for its live executable help and schema. Host helper guidance is copyable below.",
    reference: "skills/workgraph/references/cli-contract.md",
  },
  {
    name: "schema",
    summary: "Inspect exact request and result schemas.",
    command: "workgraph schema ticket.create",
    guidance:
      "The selected method shows both schemas. The native request decoder remains authoritative for cross-field invariants.",
    reference: "skills/workgraph/references/cli-contract.md",
  },
  {
    name: "migrate.cleanup",
    summary: "Clean up an explicitly owned offline migration stage.",
    command: "workgraph migrate cleanup --stage /ABSOLUTE/STAGE --owner-token OWNER_TOKEN",
    guidance:
      "Replace placeholders after inspecting the stage. This is an offline host operation for the explicit released-format migration helper, not startup compatibility or daemon RPC.",
    reference: "skills/workgraph/references/migration.md",
  },
  {
    name: "CLI aliases and option forms",
    summary: "Canonical requests, family/action syntax and helper aliases.",
    command: "workgraph help call",
    guidance:
      "The CLI supports dotted methods, family/action and request/call forms. ticket.get canonicalizes to ticket.context before saving. Bootstrap/init and documented dotted/hyphen aliases retain the same helper identity. The UI uses canonical catalogue method names.",
    reference: "skills/workgraph/references/cli-contract.md",
  },
  {
    name: "wgx",
    summary: "Optional read-only terminal views using the matching executable.",
    command: "bash /ABSOLUTE/SKILL/scripts/wgx.sh --help",
    guidance:
      "Replace the skill path. Requires the host dependencies documented by the bundled script; it never becomes a browser-executed command.",
    reference: "skills/workgraph/references/wgx.md",
  },
  {
    name: "history-adapter.py",
    summary: "Optional host-side adapter for explicit session append/import preparation.",
    command: "python3 /ABSOLUTE/SKILL/scripts/history-adapter.py --help",
    guidance:
      "Replace the skill path. Review mapped events, stable identities and saved writes before appending. Host import preparation is separate from passive history format projection.",
    reference: "skills/workgraph/references/history.md",
  },
  {
    name: "transcript-converter.py",
    summary: "Optional converter for its specifically documented transcript input.",
    command: "python3 /ABSOLUTE/SKILL/scripts/transcript-converter.py --help",
    guidance:
      "Replace the skill path. Inspect supported input and output before conversion. This does not qualify every raw Claude Code format or reconstruct retained reasoning.",
    reference: "skills/workgraph/references/history.md",
  },
]);
