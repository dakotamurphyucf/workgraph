open Core

module Capability = struct
  type t =
    { id : string
    ; title : string
    ; summary : string
    ; groups : string list
    ; reference : string
    }
end

module Group = struct
  type t =
    { id : string
    ; summary : string
    ; use_when : string
    ; distinction : string
    ; start_with : string list
    ; reference : string
    }
end

module Method = struct
  type t =
    { name : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; related : string list
    }
end

module Helper = struct
  type t =
    { name : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; capability : string
    ; effect_summary : string
    ; reference : string
    }
end

module Workflow = struct
  type t =
    { id : string
    ; title : string
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; capability : string
    ; steps : string list
    ; methods : string list
    ; reference : string
    }
end

let capabilities : Capability.t list =
  [ { id = "planning"
    ; title = "Plan work"
    ; summary =
        "Organize goals, work items, prerequisites and repeatable atomic plans before \
         dispatch."
    ; groups =
        [ "project"
        ; "milestone"
        ; "ticket"
        ; "dependency"
        ; "related"
        ; "label"
        ; "status"
        ; "template"
        ; "transaction"
        ]
    ; reference = "references/planning.md"
    }
  ; { id = "coordination"
    ; title = "Coordinate workers"
    ; summary =
        "Record real invocations, admit capable work and manage logical ownership while \
         the harness controls processes."
    ; groups =
        [ "actor"
        ; "allocation"
        ; "attempt"
        ; "condition"
        ; "coordinator"
        ; "participant"
        ; "reservation"
        ; "run"
        ]
    ; reference = "references/coordination.md"
    }
  ; { id = "communication"
    ; title = "Communicate and resolve requests"
    ; summary =
        "Send durable messages, organize discussion and track accountable questions with \
         explicit delivery and resolution."
    ; groups =
        [ "board"
        ; "comment"
        ; "inbox"
        ; "message"
        ; "request"
        ; "subscription"
        ; "team"
        ; "thread"
        ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "context"
    ; title = "Share durable context"
    ; summary =
        "Keep small scoped JSON facts and immutable text or binary resources, with \
         explicit version and digest pins."
    ; groups = [ "fact"; "resource"; "upload"; "history"; "session" ]
    ; reference = "references/resources.md"
    }
  ; { id = "recovery"
    ; title = "Resume and recover safely"
    ; summary =
        "Recover recorded handoffs and ownership audits while preserving exact retries \
         and prior execution isolation."
    ; groups = [ "handoff"; "recovery" ]
    ; reference = "references/resume-digest.md"
    }
  ; { id = "verification"
    ; title = "Verify and accept evidence"
    ; summary =
        "Define exact requirements, publish pinned outputs and record checks, review, \
         acceptance and input reconciliation."
    ; groups =
        [ "acceptance"
        ; "contract"
        ; "decision"
        ; "evidence"
        ; "input"
        ; "manifest"
        ; "reconciliation"
        ; "review"
        ; "validation"
        ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "observation"
    ; title = "Observe and wait"
    ; summary =
        "Inspect recorded changes, attention, search and reported usage through bounded \
         captures and resumable waits."
    ; groups = [ "activity"; "attention"; "changes"; "search"; "usage" ]
    ; reference = "references/attention.md"
    }
  ; { id = "administration"
    ; title = "Administer local state"
    ; summary =
        "Inspect the protocol and service, manage workspaces and recover registry \
         receipts or portable exports."
    ; groups = [ "daemon"; "export"; "initialize"; "registry"; "restore"; "workspace" ]
    ; reference = "references/administration.md"
    }
  ]
;;

let groups : Group.t list =
  [ { id = "acceptance"
    ; summary =
        "Acceptance criteria turn policy requirements into exact attributed assertions."
    ; use_when =
        "A project or ticket needs named criteria whose satisfaction is recorded against \
         a policy revision."
    ; distinction =
        "Acceptance assertions satisfy criterion policy; review decisions evaluate a \
         submitted output generation."
    ; start_with =
        [ "acceptance.policy.effective"; "acceptance.assert"; "acceptance.assertions" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "activity"
    ; summary =
        "Planning activity records durable workspace changes and supports focused \
         recovery summaries."
    ; use_when =
        "You need committed planning changes or a bounded digest of recorded work."
    ; distinction =
        "Activity is the planning audit stream; history contains explicitly imported \
         conversation events."
    ; start_with = [ "activity.digest"; "activity.since"; "activity.read" ]
    ; reference = "references/resume-digest.md"
    }
  ; { id = "actor"
    ; summary =
        "Actors catalog the cooperating people and agents attributed in a workspace."
    ; use_when =
        "You need a named identity or an inventory of its held work and requests."
    ; distinction =
        "An actor is attribution metadata; a run is one invocation and neither proves a \
         process is alive."
    ; start_with = [ "actor.overview"; "actor.list"; "actor.put" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "allocation"
    ; summary =
        "Allocation policies restrict eligible runs and shared capacity before work \
         starts."
    ; use_when =
        "Work requires named capabilities, permitted actors or a bounded shared pool."
    ; distinction =
        "Allocation decides admission; readiness reads grant nothing and a reservation \
         coordinates a specific resource."
    ; start_with =
        [ "allocation.pools"
        ; "allocation.ticket_policies"
        ; "allocation.ticket_policy_put"
        ]
    ; reference = "references/coordination.md"
    }
  ; { id = "attempt"
    ; summary =
        "An attempt records one run's effort on a ticket under a particular claim."
    ; use_when = "You need to start, checkpoint or finish a distinct try at owned work."
    ; distinction =
        "An attempt is retained execution bookkeeping; the harness launches the actual \
         process."
    ; start_with = [ "attempt.get"; "attempt.start"; "attempt.checkpoint" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "attention"
    ; summary =
        "Attention combines filtered exact-source events for a worker to inspect or wait \
         on."
    ; use_when =
        "An idle worker needs a bounded wakeup view without polling acquisition writes."
    ; distinction =
        "Attention reads acknowledge nothing; inbox acknowledgements and ownership \
         changes remain explicit."
    ; start_with = [ "attention.read"; "attention.wait" ]
    ; reference = "references/attention.md"
    }
  ; { id = "board"
    ; summary = "Boards organize independent discussion threads within a workspace."
    ; use_when =
        "Discussion needs a durable named grouping separate from ticket ownership."
    ; distinction =
        "Boards group threads; they do not create accountable requests or change ticket \
         status."
    ; start_with = [ "board.list"; "board.get"; "board.put" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "changes"
    ; summary =
        "Change feeds expose complete captured commit metadata with resumable cursors."
    ; use_when =
        "A consumer needs to follow planning or history commits and wake on matching \
         changes."
    ; distinction =
        "Changes carry commit metadata; activity and history methods expand the \
         underlying content."
    ; start_with = [ "changes.read"; "changes.wait" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "comment"
    ; summary = "Comments retain attributed text revisions on planning subjects."
    ; use_when =
        "You need to add discussion, inspect exact prior text or explicitly tombstone a \
         comment."
    ; distinction =
        "Comments are editable retained discussion; request resolution and formal review \
         use their own records."
    ; start_with = [ "comment.list"; "comment.get"; "comment.add" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "condition"
    ; summary =
        "Conditions record external prerequisites and explicit signals from the harness."
    ; use_when =
        "An outside system must report whether a work prerequisite currently holds."
    ; distinction =
        "The daemon records caller signals; it never probes external systems or infers \
         their state."
    ; start_with = [ "condition.list"; "condition.put"; "condition.signal" ]
    ; reference = "references/path-conditions-recovery.md"
    }
  ; { id = "contract"
    ; summary = "Contracts declare versioned input and output expectations for evidence."
    ; use_when =
        "An attempt's outputs must conform to a named schema or pinned expectation."
    ; distinction =
        "A contract defines requirements; a manifest names the exact produced and \
         consumed evidence."
    ; start_with = [ "contract.list"; "contract.get"; "contract.put" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "coordinator"
    ; summary =
        "The coordinator overview captures typed coordination rows across current \
         workspace state."
    ; use_when =
        "You need one bounded view of readiness, held work, requests or stale \
         observations."
    ; distinction =
        "This is an observation surface, not a scheduler or proof that a worker process \
         stopped."
    ; start_with = [ "coordinator.overview" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "daemon"
    ; summary =
        "Daemon administration controls the local service and complete registry exports."
    ; use_when =
        "You need service health, graceful shutdown or a portable complete-state \
         operation."
    ; distinction =
        "The daemon stores local state; the harness owns workers and external side \
         effects."
    ; start_with = [ "daemon.health"; "daemon.shutdown"; "daemon.export_all" ]
    ; reference = "references/administration.md"
    }
  ; { id = "decision"
    ; summary = "Decisions preserve versioned rationale and evidence as shared records."
    ; use_when = "A durable choice and its history must outlast a discussion thread."
    ; distinction =
        "A decision records rationale; it does not itself approve a submission or \
         complete work."
    ; start_with = [ "decision.list"; "decision.get"; "decision.put" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "dependency"
    ; summary =
        "Dependencies make one ticket require another and record explicit waivers."
    ; use_when =
        "Work must wait for a prerequisite, or a justified waiver should lift that block."
    ; distinction =
        "A dependency controls readiness; parenthood and related links have different \
         semantics."
    ; start_with = [ "dependency.add"; "dependency.waive"; "dependency.remove" ]
    ; reference = "references/planning.md"
    }
  ; { id = "evidence"
    ; summary =
        "Evidence context joins the exact policy, manifests, checks and review state for \
         work."
    ; use_when =
        "You need to inspect the completion evidence picture before choosing a narrower \
         method."
    ; distinction =
        "Evidence.context is a read; local evidence-run captures command output outside \
         the daemon."
    ; start_with = [ "evidence.context" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "export"
    ; summary =
        "Export jobs record complete portable-state export progress and verification."
    ; use_when =
        "You need to inspect, retry, cancel or verify an export already requested."
    ; distinction =
        "A job record is distinct from the exported artifact and from readable workspace \
         summaries."
    ; start_with = [ "export.list"; "export.get"; "export.verify" ]
    ; reference = "references/administration.md"
    }
  ; { id = "fact"
    ; summary = "Facts are bounded named JSON values in explicit work scopes."
    ; use_when =
        "Agents need small editable shared context with revision guards and retained \
         history."
    ; distinction =
        "Use facts for structured values; resources retain larger text or binary content \
         and immutable pins."
    ; start_with = [ "fact.keys"; "fact.get"; "fact.put" ]
    ; reference = "references/planning.md"
    }
  ; { id = "handoff"
    ; summary =
        "Handoffs capture structured objectives, progress, blockers and next steps under \
         ownership."
    ; use_when = "An owner must leave reliable recovery context for a later invocation."
    ; distinction =
        "Handoffs are explicit authored context; ticket.resume builds a bounded view of \
         recorded sources."
    ; start_with = [ "handoff.get"; "handoff.set"; "handoff.history" ]
    ; reference = "references/resume-digest.md"
    }
  ; { id = "history"
    ; summary =
        "History stores explicitly imported conversation and tool events with exact \
         payload retrieval."
    ; use_when =
        "You need to traverse a session, search imported events or retrieve a retained \
         payload."
    ; distinction =
        "History is separate from planning activity; Workgraph does not capture model \
         conversations automatically."
    ; start_with = [ "history.read"; "history.payloads"; "history.payload" ]
    ; reference = "references/history.md"
    }
  ; { id = "inbox"
    ; summary =
        "Inboxes deliver durable recipient notifications and track explicit \
         acknowledgements."
    ; use_when =
        "A participant needs unread notifications or must acknowledge selected delivered \
         entries."
    ; distinction =
        "Reading does not acknowledge; request delivery, responsibility and resolution \
         are separate transitions."
    ; start_with = [ "inbox.read"; "inbox.wait"; "inbox.ack" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "initialize"
    ; summary =
        "Initialization describes this daemon's API capabilities and protocol limits."
    ; use_when =
        "A client needs to learn the live protocol before sending scoped requests."
    ; distinction =
        "This is protocol discovery; local capabilities and help also work offline \
         without a daemon."
    ; start_with = [ "initialize" ]
    ; reference = "references/cli-contract.md"
    }
  ; { id = "input"
    ; summary = "Input-change records identify a pinned input that has become superseded."
    ; use_when =
        "An attempt's exact inputs changed and downstream work must reconcile explicitly."
    ; distinction =
        "Recording a change does not silently update a manifest pin or approve \
         replacement evidence."
    ; start_with = [ "input.changed" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "label"
    ; summary = "Labels catalog reusable ticket classification metadata."
    ; use_when = "Tickets need consistent tags with retained identifiers and revisions."
    ; distinction = "Labels classify work; statuses define its lifecycle categories."
    ; start_with = [ "label.list"; "label.put" ]
    ; reference = "references/planning.md"
    }
  ; { id = "manifest"
    ; summary = "Manifests pin the exact named inputs and outputs used by an attempt."
    ; use_when =
        "Work must present reproducible evidence versions for validation or review."
    ; distinction =
        "A manifest records pins; publishing one is not submission, review approval or \
         acceptance."
    ; start_with = [ "manifest.get"; "manifest.publish"; "manifest.history" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "message"
    ; summary =
        "Messages send informal immutable-body communication to frozen recipients."
    ; use_when =
        "A participant needs to send an attributed note to actors, runs or teams."
    ; distinction =
        "Messages notify; accountable questions belong in requests and formal verdicts \
         in reviews."
    ; start_with = [ "message.send" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "milestone"
    ; summary = "Milestones group project progress toward dated checkpoints."
    ; use_when =
        "A project needs dated delivery checkpoints or ticket placement within them."
    ; distinction =
        "Milestone dates organize planning; they do not schedule worker processes."
    ; start_with = [ "milestone.list"; "milestone.create"; "milestone.schedule" ]
    ; reference = "references/planning.md"
    }
  ; { id = "participant"
    ; summary =
        "Participants combine registered identities with retained attributed workspace \
         writers."
    ; use_when =
        "You need to find who actually participated, including writers absent from the \
         actor catalog."
    ; distinction =
        "Observed attribution is retained-history evidence, not current presence or \
         process liveness."
    ; start_with = [ "participant.list" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "project"
    ; summary =
        "Projects group delivery goals, tickets, milestones and completion policy."
    ; use_when =
        "You need to organize a goal, inspect its brief or check and finish the whole \
         project."
    ; distinction =
        "Project completion checks its work and gates; a project brief is only a \
         captured summary."
    ; start_with =
        [ "project.list"; "project.brief"; "project.readiness"; "project.create" ]
    ; reference = "references/planning.md"
    }
  ; { id = "reconciliation"
    ; summary =
        "Reconciliation records how work handles an explicitly changed pinned input."
    ; use_when =
        "A changed-input record requires an attributed decision about reuse or \
         replacement."
    ; distinction =
        "Reconciliation makes handling explicit; it does not rewrite old evidence or \
         rerun a process."
    ; start_with = [ "reconciliation.list"; "reconciliation.record" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "recovery"
    ; summary = "Recovery records retain guarded ownership recovery outcomes."
    ; use_when =
        "You need the audit of named or path ownership recovery already performed."
    ; distinction =
        "Use ticket.recovery for ticket-specific records; a recovery record cannot prove \
         an external process stopped."
    ; start_with = [ "recovery.list"; "recovery.get" ]
    ; reference = "references/path-conditions-recovery.md"
    }
  ; { id = "registry"
    ; summary =
        "Registry receipts recover the recorded outcome of registry-scoped mutations."
    ; use_when =
        "A workspace registration or other registry operation may have committed without \
         a reply."
    ; distinction =
        "Registry receipt identities are separate from planning and history receipt \
         namespaces."
    ; start_with = [ "registry.receipt" ]
    ; reference = "references/administration.md"
    }
  ; { id = "related"
    ; summary = "Related links connect tickets without affecting readiness."
    ; use_when = "Work is associated but neither ticket should block the other."
    ; distinction =
        "Related links are informational; dependencies enforce prerequisite order and \
         hierarchy organizes children."
    ; start_with = [ "related.add"; "related.remove" ]
    ; reference = "references/planning.md"
    }
  ; { id = "request"
    ; summary =
        "Requests track accountable questions and tasks with explicit recipients and \
         resolvers."
    ; use_when =
        "A question or action needs delivery, responsibility, resolution and retained \
         exact answers."
    ; distinction =
        "Reading, inbox acknowledgement, request acknowledgement, acceptance and \
         resolution are distinct."
    ; start_with = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "reservation"
    ; summary =
        "Reservations coordinate named resources or lexical file scopes with fencing \
         tokens."
    ; use_when =
        "Cooperating runs need shared or exclusive access, renewal, release or guarded \
         recovery."
    ; distinction =
        "These are logical grants, not filesystem locks; expiry does not free holders or \
         stop processes."
    ; start_with =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    ; reference = "references/path-conditions-recovery.md"
    }
  ; { id = "resource"
    ; summary =
        "Resources retain text or binary content with metadata revisions and immutable \
         content versions."
    ; use_when =
        "Agents need to publish documents, logs or artifacts and retrieve exact evidence \
         bytes."
    ; distinction =
        "Metadata revisions guard edits; version and digest pin immutable content, while \
         links attach it to work."
    ; start_with =
        [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    ; reference = "references/resources.md"
    }
  ; { id = "restore"
    ; summary =
        "Restore cancellation withdraws a pending uninstalled restore intent explicitly."
    ; use_when =
        "A pending restore should release reservations before any target is installed or \
         occupied."
    ; distinction =
        "Cancellation never rolls back a published target; partial publication requires \
         the original restore retry."
    ; start_with = [ "restore.cancel" ]
    ; reference = "references/administration.md"
    }
  ; { id = "review"
    ; summary =
        "Reviews freeze submitted evidence generations and record independent verdicts \
         and acceptance."
    ; use_when =
        "Outputs need configured reviewers, validation gates and explicit acceptance \
         before completion."
    ; distinction =
        "One approve verdict is not acceptance; review.accept checks the full current \
         generation's gate."
    ; start_with = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    ; reference = "references/gated-review-workflow.md"
    }
  ; { id = "run"
    ; summary =
        "Runs record attributed agent invocations, reported lifecycle, budgets and \
         observations."
    ; use_when =
        "A harness needs to register an invocation and coordinate its work and usage."
    ; distinction =
        "Run status and heartbeat are caller-reported metadata; they never launch, stop \
         or prove liveness of processes."
    ; start_with = [ "run.register"; "run.get"; "run.observe" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "search"
    ; summary =
        "Search retrieves bounded matches across captured planning entities and retained \
         content."
    ; use_when = "You know text or a concept but not the exact entity identity."
    ; distinction =
        "Search returns bounded indexed coverage; direct exact reads remain necessary \
         for complete sources."
    ; start_with = [ "search.query" ]
    ; reference = "references/planning.md"
    }
  ; { id = "session"
    ; summary =
        "Sessions group conversation and tool events explicitly imported by a harness."
    ; use_when =
        "A runner needs a retained transcript container and event append lifecycle."
    ; distinction =
        "A session stores imported events; it does not run a model or automatically \
         collect private reasoning."
    ; start_with = [ "session.list"; "session.create"; "session.append" ]
    ; reference = "references/history.md"
    }
  ; { id = "status"
    ; summary =
        "Statuses catalog ticket lifecycle categories and their planning metadata."
    ; use_when = "A workspace needs named Todo, active or terminal workflow statuses."
    ; distinction =
        "Status assignment is planning metadata; claims and attempt state govern actual \
         logical ownership."
    ; start_with = [ "status.list"; "status.put" ]
    ; reference = "references/planning.md"
    }
  ; { id = "subscription"
    ; summary = "Subscriptions retain explicit notification routing preferences."
    ; use_when =
        "A participant needs scoped notification subscriptions with guarded updates."
    ; distinction =
        "Subscriptions select delivery; they neither acknowledge notifications nor \
         execute background workers."
    ; start_with = [ "subscription.list"; "subscription.get"; "subscription.put" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "team"
    ; summary = "Teams catalog explicit cooperating actor membership."
    ; use_when = "A message or workflow needs named recipient groups."
    ; distinction =
        "Membership is cooperative routing metadata; it is not an authentication or \
         permission system."
    ; start_with = [ "team.list"; "team.get"; "team.put" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "template"
    ; summary =
        "Templates pin canonical graph specifications and instantiate deterministic \
         ticket plans."
    ; use_when =
        "You need repeatable bounded work graphs with explicit placement and allocation \
         or review policy."
    ; distinction =
        "Instantiation creates planning state; the harness still dispatches and runs the \
         workers."
    ; start_with = [ "template.list"; "template.get"; "template.instantiate" ]
    ; reference = "references/coordination.md"
    }
  ; { id = "thread"
    ; summary =
        "Threads group retained discussion with exact message and attachment references."
    ; use_when =
        "A discussion needs durable replies, pins, attachments or accountable request \
         context."
    ; distinction =
        "Threads organize messages; requests track accountable work and inboxes track \
         delivery."
    ; start_with = [ "thread.list"; "thread.get"; "thread.reply" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "ticket"
    ; summary =
        "Tickets are units of planned work with readiness, ownership, instructions and \
         completion evidence."
    ; use_when =
        "You need to find ready work, claim it, report progress or complete it safely."
    ; distinction =
        "Assignment is not ownership; claim tokens fence protected writes and the \
         harness owns actual execution."
    ; start_with = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    ; reference = "references/planning.md"
    }
  ; { id = "transaction"
    ; summary =
        "Transactions prepare and atomically publish bounded ordered planning operations."
    ; use_when =
        "Several planning changes must either all commit or all fail, including newly \
         created entity aliases."
    ; distinction =
        "Preflight validates without reserving state; only apply commits and returns a \
         durable receipt."
    ; start_with = [ "transaction.preflight"; "transaction.apply" ]
    ; reference = "references/planning.md"
    }
  ; { id = "upload"
    ; summary =
        "Upload staging accepts actor-owned opaque bytes before immutable resource \
         publication."
    ; use_when = "A resource exceeds the small text method or contains binary bytes."
    ; distinction =
        "Staging is ephemeral and unpublished; resource.finish_upload makes the content \
         durable."
    ; start_with = [ "upload.begin"; "upload.status"; "upload.chunk" ]
    ; reference = "references/resources.md"
    }
  ; { id = "usage"
    ; summary =
        "Usage records store immutable caller-reported consumption and named integer \
         samples."
    ; use_when =
        "A harness must report and aggregate observed usage for bookkeeping or budgets."
    ; distinction =
        "Reported usage is not inferred provider billing and does not itself enforce \
         external spending."
    ; start_with = [ "usage.aggregate"; "usage.report"; "usage.list" ]
    ; reference = "references/metrics.md"
    }
  ; { id = "validation"
    ; summary = "Validations record attributed check outcomes against exact evidence."
    ; use_when =
        "A gate requires a named validator's recorded result for a pinned manifest or \
         resource."
    ; distinction =
        "The record reports a caller's check; Workgraph does not execute or \
         independently verify the check."
    ; start_with = [ "validation.list"; "validation.add" ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "workspace"
    ; summary =
        "Workspaces hold independent local planning and context collections in the \
         registry."
    ; use_when =
        "You need to create or open a workspace, inspect its overview or manage portable \
         state."
    ; distinction =
        "Registry membership and open daemon handles differ from a workspace's durable \
         planning metadata."
    ; start_with = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    ; reference = "references/administration.md"
    }
  ]
;;

let methods : Method.t list =
  [ { name = "acceptance.assert"
    ; summary =
        "Record an attributed pass or fail for an exact current acceptance criterion and \
         policy digest."
    ; use_when =
        "A required criterion has been checked and needs an immutable outcome against \
         its current policy digest."
    ; search_terms = [ "criterion"; "assertion"; "acceptance evidence" ]
    ; related = [ "acceptance.policy.effective"; "acceptance.assertions" ]
    }
  ; { name = "acceptance.assertions"
    ; summary =
        "List recorded acceptance assertions and their exact criterion and evidence \
         references."
    ; use_when = "You need to inspect which policy criteria have supporting assertions."
    ; search_terms = [ "criterion evidence"; "satisfaction" ]
    ; related = [ "acceptance.policy.effective"; "acceptance.assert" ]
    }
  ; { name = "acceptance.policy.effective"
    ; summary =
        "Read the acceptance criteria effective for a ticket after applicable policy \
         inheritance."
    ; use_when =
        "You need to know which project and ticket criteria completion will check."
    ; search_terms = [ "inherited policy"; "effective criteria" ]
    ; related = [ "acceptance.assert"; "acceptance.assertions" ]
    }
  ; { name = "acceptance.policy.get"
    ; summary = "Read one scope's stored acceptance policy and its revision."
    ; use_when =
        "You need the exact policy revision before changing named completion criteria."
    ; search_terms = [ "criteria configuration" ]
    ; related =
        [ "acceptance.policy.effective"; "acceptance.assert"; "acceptance.assertions" ]
    }
  ; { name = "acceptance.policy.put"
    ; summary =
        "Create or replace guarded acceptance criteria for a project or ticket scope."
    ; use_when =
        "Named evidence criteria must be installed before completing affected work."
    ; search_terms = [ "configure criteria"; "completion gate" ]
    ; related =
        [ "acceptance.policy.effective"; "acceptance.assert"; "acceptance.assertions" ]
    }
  ; { name = "activity.digest"
    ; summary =
        "Build a bounded deterministic digest of recorded planning activity with exact \
         source references."
    ; use_when =
        "You need a concise catch-up view of durable changes rather than full audit \
         payloads."
    ; search_terms = [ "catch up"; "what changed"; "resume summary" ]
    ; related = [ "ticket.resume"; "activity.since"; "activity.read" ]
    }
  ; { name = "activity.read"
    ; summary =
        "Traverse captured planning audit changes as bounded canonical JSON chunks."
    ; use_when =
        "You need exact audit payloads beyond the semantic summary returned by \
         activity.digest."
    ; search_terms = [ "audit bytes"; "canonical JSON"; "full changes" ]
    ; related = [ "activity.since"; "activity.digest"; "history.read" ]
    }
  ; { name = "activity.since"
    ; summary = "Read bounded committed planning activity after a retained sequence."
    ; use_when =
        "A client must incrementally inspect the planning changes since its last \
         position."
    ; search_terms = [ "incremental changes"; "planning feed" ]
    ; related = [ "changes.read"; "activity.digest" ]
    }
  ; { name = "actor.list"
    ; summary = "List registered actor identities and their catalog metadata."
    ; use_when =
        "You need the declared identity catalog rather than all retained attributed \
         writers."
    ; search_terms = [ "registered identities" ]
    ; related = [ "actor.overview"; "actor.put" ]
    }
  ; { name = "actor.overview"
    ; summary =
        "Read an actor's held ownership, requests and selected unread state in one \
         capture."
    ; use_when =
        "You need an inventory of an owner's logical work before a handoff or recovery."
    ; search_terms = [ "held work"; "owner inventory" ]
    ; related = [ "actor.list"; "actor.put" ]
    }
  ; { name = "actor.put"
    ; summary = "Create or update guarded actor identity metadata."
    ; use_when =
        "A cooperating person or agent needs a catalog identity with explicit \
         descriptive metadata."
    ; search_terms = [ "register actor"; "identity catalog" ]
    ; related = [ "actor.overview"; "actor.list" ]
    }
  ; { name = "allocation.pool_put"
    ; summary = "Create or update a shared allocation pool's guarded capacity limits."
    ; use_when =
        "You must limit how many admitted attempts can consume a shared capability or \
         service."
    ; search_terms = [ "capacity limit"; "parallel jobs" ]
    ; related =
        [ "allocation.pools"
        ; "allocation.ticket_policies"
        ; "allocation.ticket_policy_put"
        ]
    }
  ; { name = "allocation.pools"
    ; summary = "Read shared allocation pools and their recorded capacity policy."
    ; use_when = "You need to inspect configured pool limits before diagnosing admission."
    ; search_terms = [ "capacity policy"; "pool limits" ]
    ; related = [ "allocation.ticket_policies"; "allocation.ticket_policy_put" ]
    }
  ; { name = "allocation.ticket_policies"
    ; summary =
        "Read ticket-specific allocation requirements and their independent policy \
         revisions."
    ; use_when =
        "You need the current allowed actors, capabilities and pool requirements for \
         work."
    ; search_terms = [ "eligibility"; "allowed actors" ]
    ; related = [ "allocation.pools"; "allocation.ticket_policy_put" ]
    }
  ; { name = "allocation.ticket_policy_put"
    ; summary =
        "Install guarded capability, actor and pool requirements for a ticket's \
         allocation."
    ; use_when =
        "Only specified actors or capable runs should acquire a ticket, or it must \
         consume shared capacity."
    ; search_terms = [ "restrict dispatch"; "allowed actors"; "capabilities" ]
    ; related = [ "allocation.pools"; "allocation.ticket_policies" ]
    }
  ; { name = "attempt.checkpoint"
    ; summary = "Append an immutable checkpoint to an owned active attempt."
    ; use_when =
        "A run needs to retain progress within its current try without finishing it."
    ; search_terms = [ "save checkpoint"; "execution progress" ]
    ; related = [ "attempt.get"; "attempt.start" ]
    }
  ; { name = "attempt.finish"
    ; summary =
        "Record a guarded terminal outcome for an attempt without implicitly completing \
         its ticket."
    ; use_when =
        "One recorded try ended and its outcome must be retained separately from ticket \
         completion."
    ; search_terms = [ "failed attempt"; "complete attempt" ]
    ; related = [ "attempt.get"; "attempt.start"; "attempt.checkpoint" ]
    }
  ; { name = "attempt.get"
    ; summary =
        "Read one attempt's owner, claim binding, checkpoints and current revision."
    ; use_when = "You need the exact retained state and guard for a particular try."
    ; search_terms = [ "attempt revision"; "claim binding" ]
    ; related = [ "attempt.start"; "attempt.checkpoint" ]
    }
  ; { name = "attempt.list"
    ; summary = "List attempts under explicit ticket, run and state filters."
    ; use_when = "You need to find prior or active tries for a ticket or invocation."
    ; search_terms = [ "attempt history"; "active tries" ]
    ; related = [ "attempt.get"; "attempt.start"; "attempt.checkpoint" ]
    }
  ; { name = "attempt.start"
    ; summary =
        "Start a recorded attempt under an existing valid ticket claim and admitted run."
    ; use_when =
        "The ticket is already claimed and you now need a distinct execution attempt."
    ; search_terms = [ "start try"; "claimed work" ]
    ; related = [ "attempt.get"; "attempt.checkpoint" ]
    }
  ; { name = "attention.read"
    ; summary =
        "Read filtered attention events with exact source references and bounded \
         coverage."
    ; use_when =
        "An idle worker needs a current view before deciding whether to act or wait."
    ; search_terms = [ "attention capture"; "idle worker" ]
    ; related = [ "attention.wait"; "ticket.readiness"; "inbox.read" ]
    }
  ; { name = "attention.wait"
    ; summary =
        "Wait for filtered attention after the captured position without acknowledging \
         sources."
    ; use_when =
        "A worker has inspected its capture and needs a bounded wakeup when relevant \
         work changes."
    ; search_terms = [ "park worker"; "wakeup"; "avoid polling" ]
    ; related = [ "attention.read"; "changes.wait"; "inbox.wait" ]
    }
  ; { name = "board.get"
    ; summary = "Read a discussion board and its current metadata revision."
    ; use_when =
        "You need the board's scope and metadata before opening or updating a discussion."
    ; search_terms = [ "discussion scope" ]
    ; related = [ "board.list"; "board.put" ]
    }
  ; { name = "board.list"
    ; summary = "List discussion boards in explicit workspace or project scope."
    ; use_when =
        "You need to find a durable discussion grouping before creating a thread."
    ; search_terms = [ "find board"; "forum" ]
    ; related = [ "board.get"; "board.put" ]
    }
  ; { name = "board.put"
    ; summary =
        "Create a discussion board at revision zero or update its guarded metadata."
    ; use_when =
        "A discussion needs a named board or its existing metadata must change safely."
    ; search_terms = [ "create board"; "discussion grouping" ]
    ; related = [ "board.list"; "board.get" ]
    }
  ; { name = "changes.read"
    ; summary = "Read complete captured commit metadata with exact prefix continuation."
    ; use_when =
        "A consumer must follow planning or history commits without loading every \
         payload."
    ; search_terms = [ "watch changes"; "commit metadata" ]
    ; related = [ "changes.wait"; "activity.since"; "history.read" ]
    }
  ; { name = "changes.wait"
    ; summary =
        "Wait for matching commit metadata while preserving the feed's exact cursor and \
         filters."
    ; use_when =
        "A feed consumer has caught up and needs a bounded wait for another matching \
         commit."
    ; search_terms = [ "watch feed"; "long poll"; "wakeup" ]
    ; related = [ "changes.read"; "attention.wait" ]
    }
  ; { name = "comment.add"
    ; summary = "Add an attributed comment to a supported planning subject."
    ; use_when =
        "You need durable discussion text without changing ownership or satisfying a \
         formal gate."
    ; search_terms = [ "add note"; "discussion"; "progress note" ]
    ; related = [ "comment.list"; "comment.get" ]
    }
  ; { name = "comment.edit"
    ; summary = "Publish a guarded new text revision of an existing comment."
    ; use_when =
        "A comment needs correction while its prior text and attribution remain retained."
    ; search_terms = [ "edit note"; "correct text" ]
    ; related = [ "comment.list"; "comment.get"; "comment.add" ]
    }
  ; { name = "comment.get"
    ; summary = "Read a comment's current retained text and provenance."
    ; use_when =
        "You need current comment text or its revision before editing it; use history \
         for prior versions."
    ; search_terms = [ "current comment"; "comment revision" ]
    ; related = [ "comment.list"; "comment.add" ]
    }
  ; { name = "comment.history"
    ; summary = "Read a comment's retained attributed revisions in order."
    ; use_when = "You need to inspect how discussion text changed over time."
    ; search_terms = [ "comment revisions"; "edit history" ]
    ; related = [ "comment.list"; "comment.get"; "comment.add" ]
    }
  ; { name = "comment.list"
    ; summary = "List comments attached to a selected planning subject."
    ; use_when =
        "You need the retained discussion for a ticket or other supported entity."
    ; search_terms = [ "ticket comments"; "discussion notes" ]
    ; related = [ "comment.get"; "comment.add" ]
    }
  ; { name = "comment.tombstone"
    ; summary = "Mark a comment as tombstoned while retaining its revision history."
    ; use_when =
        "Discussion text must be explicitly withdrawn without erasing historical \
         references."
    ; search_terms = [ "withdraw comment"; "remove note" ]
    ; related = [ "comment.list"; "comment.get"; "comment.add" ]
    }
  ; { name = "condition.get"
    ; summary = "Read one external condition's definition and revision."
    ; use_when =
        "You need to inspect the declared external prerequisite before signaling it."
    ; search_terms = [ "external gate definition" ]
    ; related = [ "condition.list"; "condition.put"; "condition.signal" ]
    }
  ; { name = "condition.list"
    ; summary = "List declared external conditions under explicit scope filters."
    ; use_when = "You need to discover the outside prerequisites affecting work."
    ; search_terms = [ "environment requirements" ]
    ; related = [ "condition.put"; "condition.signal" ]
    }
  ; { name = "condition.put"
    ; summary = "Create or update a guarded external-condition definition."
    ; use_when =
        "A harness-reported prerequisite must be declared before work can depend on it."
    ; search_terms = [ "define external prerequisite" ]
    ; related = [ "condition.list"; "condition.signal" ]
    }
  ; { name = "condition.signal"
    ; summary = "Record an explicit attributed state signal for an external condition."
    ; use_when =
        "The harness has checked an outside prerequisite and must report its result."
    ; search_terms = [ "signal ready"; "external check" ]
    ; related = [ "condition.list"; "condition.put" ]
    }
  ; { name = "condition.signals"
    ; summary = "Read retained attributed signals for an external condition."
    ; use_when = "You need to inspect who reported a prerequisite's state and when."
    ; search_terms = [ "signal history"; "external observations" ]
    ; related = [ "condition.list"; "condition.put"; "condition.signal" ]
    }
  ; { name = "contract.get"
    ; summary =
        "Read an exact or current contract version and its pinned schema requirements."
    ; use_when =
        "You need the requirements used to validate a particular output manifest."
    ; search_terms = [ "contract revision"; "schema pin" ]
    ; related = [ "contract.list"; "contract.put" ]
    }
  ; { name = "contract.history"
    ; summary = "Read retained contract versions and their attribution."
    ; use_when = "You need to compare how input or output requirements changed."
    ; search_terms = [ "requirements history" ]
    ; related = [ "contract.list"; "contract.get"; "contract.put" ]
    }
  ; { name = "contract.list"
    ; summary = "List evidence contracts under explicit filters."
    ; use_when =
        "You need to find the expected artifact contract before publishing a manifest."
    ; search_terms = [ "artifact contracts" ]
    ; related = [ "contract.get"; "contract.put" ]
    }
  ; { name = "contract.put"
    ; summary =
        "Publish guarded versioned input and output requirements with exact schema \
         references."
    ; use_when = "A project or ticket needs a durable contract for its evidence."
    ; search_terms = [ "define output contract"; "schema requirement" ]
    ; related = [ "contract.list"; "contract.get" ]
    }
  ; { name = "coordinator.overview"
    ; summary =
        "Read bounded whole coordination rows from one planning, history and heartbeat \
         capture."
    ; use_when =
        "You need a current dashboard of readiness, held work or stale run observations."
    ; search_terms = [ "stale workers"; "coordination dashboard" ]
    ; related = [ "actor.overview"; "ticket.readiness"; "participant.list" ]
    }
  ; { name = "daemon.export_all"
    ; summary =
        "Start a captured export of all registered workspaces, reporting any explicitly \
         omitted members."
    ; use_when = "You need a portable multi-workspace backup with a recorded export job."
    ; search_terms = [ "backup all"; "export registry" ]
    ; related = [ "daemon.health"; "daemon.shutdown" ]
    }
  ; { name = "daemon.health"
    ; summary =
        "Read local daemon health, registry fences and registered workspace availability."
    ; use_when =
        "You need to diagnose service readiness or quarantined workspaces before normal \
         operations."
    ; search_terms = [ "service readiness"; "quarantine"; "health check" ]
    ; related = [ "daemon.shutdown"; "daemon.export_all" ]
    }
  ; { name = "daemon.restore_all"
    ; summary =
        "Verify and restore every member of a complete export container into fresh \
         mapped roots."
    ; use_when =
        "You need to recover a full multi-workspace backup into a registry without those \
         identities."
    ; search_terms = [ "restore all"; "portable backup" ]
    ; related = [ "daemon.health"; "daemon.shutdown"; "daemon.export_all" ]
    }
  ; { name = "daemon.shutdown"
    ; summary = "Drain admitted operations and gracefully stop the local daemon."
    ; use_when =
        "The service must stop while preserving managed state and finishing admitted \
         work."
    ; search_terms = [ "stop service"; "graceful drain" ]
    ; related = [ "daemon.health"; "daemon.export_all" ]
    }
  ; { name = "decision.get"
    ; summary = "Read a retained decision's current or exact version and rationale."
    ; use_when =
        "You need the recorded choice behind an implementation or evidence decision."
    ; search_terms = [ "decision rationale" ]
    ; related = [ "decision.list"; "decision.put" ]
    }
  ; { name = "decision.history"
    ; summary = "Read retained attributed versions of a decision."
    ; use_when = "You need to trace how a recorded choice or its rationale evolved."
    ; search_terms = [ "rationale history" ]
    ; related = [ "decision.list"; "decision.get"; "decision.put" ]
    }
  ; { name = "decision.list"
    ; summary = "List recorded decisions matching explicit scope filters."
    ; use_when = "You need to find durable choices relevant to the current work."
    ; search_terms = [ "find decisions" ]
    ; related = [ "decision.get"; "decision.put" ]
    }
  ; { name = "decision.put"
    ; summary =
        "Publish a guarded versioned decision with its rationale and evidence references."
    ; use_when = "A choice needs a durable shared record beyond informal discussion."
    ; search_terms = [ "record rationale"; "architecture decision" ]
    ; related = [ "decision.list"; "decision.get" ]
    }
  ; { name = "dependency.add"
    ; summary =
        "Add a directed prerequisite edge between tickets, rejecting invalid cycles."
    ; use_when = "One ticket must wait until another ticket is complete."
    ; search_terms = [ "blocked by"; "prerequisite edge" ]
    ; related = [ "dependency.waive"; "dependency.remove" ]
    }
  ; { name = "dependency.remove"
    ; summary = "Remove an explicitly selected prerequisite relationship between tickets."
    ; use_when = "The ordering requirement itself has been intentionally removed."
    ; search_terms = [ "remove prerequisite" ]
    ; related = [ "dependency.add"; "dependency.waive" ]
    }
  ; { name = "dependency.waive"
    ; summary =
        "Record an explicit reason to waive a prerequisite's blocking effect without \
         removing its edge."
    ; use_when = "A dependency remains informative but should no longer block this work."
    ; search_terms = [ "waive blocker"; "exception reason" ]
    ; related = [ "dependency.add"; "dependency.remove" ]
    }
  ; { name = "evidence.context"
    ; summary =
        "Read the captured contracts, manifests, checks and policy evidence relevant to \
         work."
    ; use_when =
        "You need a joined evidence picture before inspecting or satisfying individual \
         gates."
    ; search_terms = [ "completion proof"; "evidence overview" ]
    ; related = [ "review.gate"; "acceptance.policy.effective"; "manifest.get" ]
    }
  ; { name = "export.cancel"
    ; summary =
        "Request cancellation of an active export before its destination is published."
    ; use_when =
        "An export is no longer needed and must stop without publishing an incomplete \
         backup."
    ; search_terms = [ "cancel backup" ]
    ; related = [ "export.list"; "export.get"; "export.verify" ]
    }
  ; { name = "export.get"
    ; summary =
        "Read an export job's current status, captured heads and publication outcome."
    ; use_when =
        "You need to poll the actual job instead of treating its admission receipt as \
         completion."
    ; search_terms = [ "backup status"; "job progress" ]
    ; related = [ "export.list"; "export.verify" ]
    }
  ; { name = "export.list"
    ; summary = "List complete export-job records under a fixed listing snapshot."
    ; use_when =
        "You need to inspect retained export jobs and continue their bounded listing \
         safely."
    ; search_terms = [ "backup inventory" ]
    ; related = [ "export.get"; "export.verify" ]
    }
  ; { name = "export.retry"
    ; summary =
        "Retry a failed, cancelled or interrupted export using its original immutable \
         capture."
    ; use_when =
        "The job must materialize the same backup capture again into its still-fresh \
         destination."
    ; search_terms = [ "retry backup"; "original capture" ]
    ; related = [ "export.list"; "export.get"; "export.verify" ]
    }
  ; { name = "export.verify"
    ; summary =
        "Verify an exported workspace's inventory, hashes, paths and captured metadata."
    ; use_when =
        "You need to check a published backup's integrity before restore or transport."
    ; search_terms = [ "backup integrity"; "verify hashes" ]
    ; related = [ "export.list"; "export.get" ]
    }
  ; { name = "fact.delete"
    ; summary =
        "Delete a scoped fact under its revision guard while retaining a tombstone and \
         history."
    ; use_when =
        "A named JSON value should cease to be current without losing its prior versions."
    ; search_terms = [ "remove key"; "fact tombstone" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "fact.get"
    ; summary = "Read one named scoped JSON fact and its current revision."
    ; use_when = "You know the key and need its value or a guard for replacement."
    ; search_terms = [ "lookup key"; "read value" ]
    ; related = [ "fact.keys"; "fact.put" ]
    }
  ; { name = "fact.history"
    ; summary =
        "Read retained attributed versions and deletion history for a scoped fact."
    ; use_when = "You need to understand how shared structured context changed."
    ; search_terms = [ "value history"; "prior memory" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "fact.keys"
    ; summary = "Discover scoped fact keys without loading their JSON values."
    ; use_when =
        "You need to find available shared context cheaply before selecting values."
    ; search_terms = [ "discover keys"; "memory index" ]
    ; related = [ "fact.get"; "fact.put" ]
    }
  ; { name = "fact.list"
    ; summary =
        "List scoped fact values and metadata under explicit filters and byte bounds."
    ; use_when = "You need a bounded view of the shared JSON values in a work scope."
    ; search_terms = [ "shared memory values" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "fact.multi_get"
    ; summary = "Read an explicit collection of scoped fact keys in one capture."
    ; use_when =
        "You already know several context keys and want their values consistently."
    ; search_terms = [ "batch keys"; "selected memory" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "fact.put"
    ; summary = "Write one bounded scoped JSON fact with its required revision guard."
    ; use_when = "Small structured shared context must be created or replaced safely."
    ; search_terms = [ "save JSON"; "working memory" ]
    ; related = [ "fact.keys"; "fact.get" ]
    }
  ; { name = "fact.references"
    ; summary =
        "Find scoped facts with explicitly declared ticket or resource navigation \
         references."
    ; use_when =
        "You need facts that declare links to selected work or content without inferring \
         IDs from JSON values."
    ; search_terms = [ "fact links"; "context references" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "fact.search"
    ; summary =
        "Search scoped fact keys and retained searchable value text with bounded \
         coverage."
    ; use_when = "You need to find structured context by text rather than an exact key."
    ; search_terms = [ "find memory"; "search JSON" ]
    ; related = [ "fact.keys"; "fact.get"; "fact.put" ]
    }
  ; { name = "handoff.get"
    ; summary = "Read the current structured handoff and its independent revision."
    ; use_when =
        "You need the owner's recorded objective, progress, blockers and next steps."
    ; search_terms = [ "read handoff"; "resume owner" ]
    ; related = [ "handoff.set"; "handoff.history" ]
    }
  ; { name = "handoff.history"
    ; summary = "Read retained attributed revisions of a ticket's structured handoff."
    ; use_when =
        "You need to inspect earlier recovery context rather than only the latest \
         handoff."
    ; search_terms = [ "handoff revisions" ]
    ; related = [ "handoff.get"; "handoff.set" ]
    }
  ; { name = "handoff.set"
    ; summary = "Publish a structured ownership-guarded handoff with explicit coverage."
    ; use_when =
        "A current owner must save progress and context before compaction or handoff. \
         Set covers_through to the last planning sequence actually inspected; omission \
         defaults to zero and causes freshness warnings."
    ; search_terms = [ "save handoff"; "next steps" ]
    ; related = [ "handoff.get"; "handoff.history" ]
    }
  ; { name = "run.sessions"
    ; summary =
        "List a run's explicit and automatically attributed conversation sessions."
    ; use_when =
        "You know the run and need every associated session without scanning all \
         sessions. Follow the pinned history head and run revision for subsequent pages."
    ; search_terms =
        [ "run conversation"; "sessions for worker"; "reverse session lookup" ]
    ; related = [ "run.get"; "run.list"; "session.list"; "history.read" ]
    }
  ; { name = "history.get"
    ; summary = "Read one retained conversation event and its exact source metadata."
    ; use_when =
        "You know an event identity and need its recorded content or payload reference."
    ; search_terms = [ "exact event"; "conversation entry" ]
    ; related = [ "history.read"; "history.payload" ]
    }
  ; { name = "history.payload"
    ; summary = "Read a bounded exact payload range from retained conversation history."
    ; use_when =
        "An event refers to a larger retained message or tool payload that must be \
         expanded."
    ; search_terms = [ "tool payload"; "transcript bytes" ]
    ; related = [ "history.payloads"; "history.read"; "history.get" ]
    }
  ; { name = "history.payloads"
    ; summary = "Read bounded payload prefixes for many exact events in one capture."
    ; use_when =
        "You have a page of event references and need their content without one call per \
         event. Follow each partial payload with history.payload at the same head."
    ; search_terms = [ "batch transcript"; "many messages"; "inline content" ]
    ; related = [ "history.read"; "history.payload" ]
    }
  ; { name = "history.read"
    ; summary =
        "Traverse explicitly imported session events under a fixed history capture."
    ; use_when =
        "You need ordered conversation or tool history with resumable bounded retrieval."
    ; search_terms = [ "read transcript"; "session events" ]
    ; related = [ "history.get"; "history.payload" ]
    }
  ; { name = "history.search"
    ; summary =
        "Search retained imported conversation events with bounded results and source \
         coverage."
    ; use_when = "You need to find a prior visible message or tool event by text."
    ; search_terms = [ "find conversation"; "transcript search" ]
    ; related = [ "history.read"; "history.get"; "history.payload" ]
    }
  ; { name = "inbox.ack"
    ; summary =
        "Acknowledge only selected delivered inbox entries for an explicit consumer."
    ; use_when =
        "The harness has processed those deliveries and must advance its own \
         acknowledgement state."
    ; search_terms = [ "mark read"; "ack delivery" ]
    ; related = [ "inbox.read"; "inbox.wait" ]
    }
  ; { name = "inbox.read"
    ; summary =
        "Read bounded recipient notifications with resumable visible-row pagination."
    ; use_when =
        "You need unread delivery for an actor or run without marking anything processed."
    ; search_terms = [ "unread notifications"; "incoming messages" ]
    ; related = [ "inbox.wait"; "inbox.ack" ]
    }
  ; { name = "inbox.wait"
    ; summary =
        "Wait up to 25 seconds for recipient notifications without acknowledging them."
    ; use_when =
        "A recipient has checked its inbox and needs a bounded wait for another delivery."
    ; search_terms = [ "wait message"; "long poll" ]
    ; related = [ "inbox.read"; "inbox.ack" ]
    }
  ; { name = "initialize"
    ; summary = "Read live daemon capabilities, protocol version and request limits."
    ; use_when = "A client is establishing the current API contract before scoped calls."
    ; search_terms = [ "handshake"; "API limits" ]
    ; related = [ "daemon.health" ]
    }
  ; { name = "input.changed"
    ; summary =
        "Record that an exact pinned input has been superseded, retaining the \
         changed-input evidence."
    ; use_when =
        "A harness detected new input and must make its impact explicit for downstream \
         reconciliation."
    ; search_terms = [ "stale input"; "invalidate pin" ]
    ; related = [ "reconciliation.list"; "reconciliation.record"; "manifest.get" ]
    }
  ; { name = "label.list"
    ; summary = "List reusable ticket labels and their metadata."
    ; use_when = "You need existing classification tags before applying ticket metadata."
    ; search_terms = [ "available tags" ]
    ; related = [ "label.put" ]
    }
  ; { name = "label.put"
    ; summary = "Create or update guarded metadata for a reusable ticket label."
    ; use_when = "Work needs a consistent classification tag with its own identity."
    ; search_terms = [ "define tag"; "classification" ]
    ; related = [ "label.list" ]
    }
  ; { name = "manifest.get"
    ; summary =
        "Read a manifest's exact named input and output pins at a selected revision."
    ; use_when = "You need the evidence bundle bound to an attempt or submission."
    ; search_terms = [ "manifest pin"; "output bundle" ]
    ; related = [ "manifest.publish"; "manifest.history" ]
    }
  ; { name = "manifest.history"
    ; summary = "Read retained manifest revisions and attribution."
    ; use_when =
        "You need to compare the exact evidence bundles published across revisions."
    ; search_terms = [ "artifact history" ]
    ; related = [ "manifest.get"; "manifest.publish" ]
    }
  ; { name = "manifest.list"
    ; summary = "List manifests matching explicit ticket, attempt or contract filters."
    ; use_when =
        "You need to find published evidence bundles before selecting an exact revision."
    ; search_terms = [ "find artifacts" ]
    ; related = [ "manifest.get"; "manifest.publish"; "manifest.history" ]
    }
  ; { name = "manifest.publish"
    ; summary =
        "Publish a guarded manifest binding an attempt's named inputs and outputs to \
         exact evidence pins."
    ; use_when =
        "Produced output must be recorded reproducibly before validation or submission."
    ; search_terms = [ "publish outputs"; "pin artifacts" ]
    ; related = [ "manifest.get"; "manifest.history" ]
    }
  ; { name = "message.send"
    ; summary =
        "Send an immutable-body informal message with frozen actor, run or team routing."
    ; use_when =
        "You need durable direct communication without creating accountable request work."
    ; search_terms = [ "tell worker"; "send note"; "notify team" ]
    ; related = [ "request.ask"; "inbox.read"; "thread.reply" ]
    }
  ; { name = "milestone.archive"
    ; summary = "Archive a milestone while retaining its recorded work and history."
    ; use_when =
        "A checkpoint is no longer active and should disappear from ordinary planning \
         views."
    ; search_terms = [ "retire milestone" ]
    ; related = [ "milestone.list"; "milestone.create"; "milestone.schedule" ]
    }
  ; { name = "milestone.create"
    ; summary = "Create a dated project milestone with explicit planning metadata."
    ; use_when = "A delivery goal needs a checkpoint grouping its tickets."
    ; search_terms = [ "create checkpoint" ]
    ; related = [ "milestone.list"; "milestone.schedule" ]
    }
  ; { name = "milestone.get"
    ; summary = "Read a milestone's metadata, placement and current revision."
    ; use_when =
        "You need the exact checkpoint record before updating its schedule or \
         description."
    ; search_terms = [ "checkpoint metadata" ]
    ; related = [ "milestone.list"; "milestone.create"; "milestone.schedule" ]
    }
  ; { name = "milestone.list"
    ; summary = "List milestones under project and archive filters."
    ; use_when = "You need to inspect the delivery checkpoints within a project."
    ; search_terms = [ "project checkpoints" ]
    ; related = [ "milestone.create"; "milestone.schedule" ]
    }
  ; { name = "milestone.schedule"
    ; summary = "Update a milestone's guarded date schedule."
    ; use_when = "A checkpoint's planned dates changed and should be recorded explicitly."
    ; search_terms = [ "change date"; "deadline" ]
    ; related = [ "milestone.list"; "milestone.create" ]
    }
  ; { name = "milestone.update"
    ; summary =
        "Update selected milestone planning fields under its entity revision guard."
    ; use_when = "A checkpoint needs metadata changes without replacing unrelated fields."
    ; search_terms = [ "edit checkpoint" ]
    ; related = [ "milestone.list"; "milestone.create"; "milestone.schedule" ]
    }
  ; { name = "participant.list"
    ; summary =
        "Discover catalog actors and retained attributed participants without inferring \
         liveness."
    ; use_when =
        "You need the authors who actually wrote retained workspace state, including \
         uncatalogued actors."
    ; search_terms = [ "who contributed"; "observed writers" ]
    ; related = [ "actor.list"; "actor.overview"; "run.list" ]
    }
  ; { name = "project.archive"
    ; summary = "Archive a project while preserving its planning state and history."
    ; use_when =
        "An inactive delivery goal should be omitted from ordinary project lists."
    ; search_terms = [ "retire project" ]
    ; related = [ "project.list"; "project.brief"; "project.readiness"; "project.create" ]
    }
  ; { name = "project.brief"
    ; summary = "Read a bounded captured project summary with tickets and milestones."
    ; use_when = "You need an overview before expanding particular work or checkpoints."
    ; search_terms = [ "project summary" ]
    ; related = [ "project.list"; "project.readiness"; "project.create" ]
    }
  ; { name = "project.create"
    ; summary = "Create a project for a delivery goal with explicit planning metadata."
    ; use_when = "New work needs a named scope for its tickets and milestones."
    ; search_terms = [ "new delivery goal" ]
    ; related = [ "project.list"; "project.brief"; "project.readiness" ]
    }
  ; { name = "project.finish"
    ; summary =
        "Complete a project after its captured work, ownership and configured gates \
         permit it."
    ; use_when =
        "The whole delivery goal is ready to close rather than merely one ticket."
    ; search_terms = [ "close project"; "finish goal" ]
    ; related = [ "project.list"; "project.brief"; "project.readiness"; "project.create" ]
    }
  ; { name = "project.get"
    ; summary = "Read a project's planning metadata and current entity revision."
    ; use_when = "You need the project's exact record or guard before editing it."
    ; search_terms = [ "project revision" ]
    ; related = [ "project.list"; "project.brief"; "project.readiness"; "project.create" ]
    }
  ; { name = "project.list"
    ; summary = "List projects matching explicit archive and planning filters."
    ; use_when = "You need to discover delivery goals in a workspace."
    ; search_terms = [ "find projects" ]
    ; related = [ "project.brief"; "project.readiness"; "project.create" ]
    }
  ; { name = "project.readiness"
    ; summary = "Check project completion, ownership and gates without changing work."
    ; use_when = "You need to understand what remains before project.finish can succeed."
    ; search_terms = [ "project blockers"; "closeout readiness" ]
    ; related = [ "project.list"; "project.brief"; "project.create" ]
    }
  ; { name = "project.update"
    ; summary = "Update selected project planning fields under its entity revision guard."
    ; use_when =
        "A delivery goal's title, description or other supported metadata changed."
    ; search_terms = [ "edit project" ]
    ; related = [ "project.list"; "project.brief"; "project.readiness"; "project.create" ]
    }
  ; { name = "reconciliation.list"
    ; summary = "List recorded reconciliations for explicitly changed evidence inputs."
    ; use_when =
        "You need to inspect whether changed inputs were handled and by which decision."
    ; search_terms = [ "input handling audit" ]
    ; related = [ "reconciliation.record" ]
    }
  ; { name = "reconciliation.record"
    ; summary =
        "Record an attributed reconciliation decision for an explicitly changed pinned \
         input."
    ; use_when = "A worker has assessed an input change and must document its handling."
    ; search_terms = [ "accept changed input"; "impact decision" ]
    ; related = [ "reconciliation.list" ]
    }
  ; { name = "recovery.get"
    ; summary = "Read one immutable named or path ownership-recovery audit record."
    ; use_when = "You need the exact guards, target and disposition of a prior recovery."
    ; search_terms = [ "reservation recovery audit" ]
    ; related = [ "recovery.list" ]
    }
  ; { name = "recovery.list"
    ; summary = "List retained ownership-recovery audit records under explicit filters."
    ; use_when =
        "You need to inspect prior recoveries without inferring current process state."
    ; search_terms = [ "recovery history" ]
    ; related = [ "recovery.get" ]
    }
  ; { name = "registry.receipt"
    ; summary =
        "Read the registry-scoped durable receipt or pending intent for an exact \
         mutation identity."
    ; use_when =
        "An administrative write may have committed and its saved request needs outcome \
         recovery."
    ; search_terms = [ "administrative receipt"; "uncertain setup" ]
    ; related = [ "workspace.receipt"; "retry"; "journal.inspect" ]
    }
  ; { name = "related.add"
    ; summary =
        "Add an informational relationship between tickets without changing readiness."
    ; use_when =
        "Two tasks share context but neither should become the other's prerequisite."
    ; search_terms = [ "associate tasks"; "related link" ]
    ; related = [ "related.remove" ]
    }
  ; { name = "related.remove"
    ; summary = "Remove an informational relationship between tickets."
    ; use_when = "The recorded association no longer helps navigate the plan."
    ; search_terms = [ "unlink related tasks" ]
    ; related = [ "related.add" ]
    }
  ; { name = "request.accept"
    ; summary =
        "Record a recipient's explicit acceptance of responsibility for a request."
    ; use_when =
        "A delivered accountable task is being taken on, separately from resolving it."
    ; search_terms = [ "take responsibility"; "accept task" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.acknowledge"
    ; summary = "Record explicit delivery acknowledgement for a request recipient."
    ; use_when =
        "A recipient must confirm receipt without accepting responsibility or resolving \
         the request."
    ; search_terms = [ "confirm receipt"; "delivery acknowledgement" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.ask"
    ; summary =
        "Ask an accountable question and create its discussion and request atomically."
    ; use_when =
        "A question needs a designated resolver, exact question body and durable answer \
         lifecycle."
    ; search_terms = [ "ask question"; "clarification" ]
    ; related = [ "request.get"; "request.resolve"; "request.wait" ]
    }
  ; { name = "request.cancel"
    ; summary = "Cancel an accountable request under its current revision guard."
    ; use_when =
        "The question or task is no longer required and should become terminal without \
         resolution."
    ; search_terms = [ "withdraw request"; "cancel question" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.create"
    ; summary =
        "Create an accountable request with explicit recipients and a designated \
         resolver."
    ; use_when =
        "An existing discussion or action needs a separately tracked request lifecycle."
    ; search_terms = [ "assign request"; "accountable action" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.get"
    ; summary =
        "Read a request's pinned question, exact answer and current thread revision."
    ; use_when =
        "You need the actual resolution body or the current guard before a request \
         transition."
    ; search_terms = [ "get answer"; "question body" ]
    ; related = [ "request.ask"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.history"
    ; summary = "Read retained attributed request transitions and metadata revisions."
    ; use_when =
        "You need to trace delivery, responsibility, reassignment or resolution of a \
         request."
    ; search_terms = [ "request lifecycle audit" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.list"
    ; summary =
        "List requests with recipient, ticket and resolver filters; reading acknowledges \
         nothing."
    ; use_when = "You need outstanding accountable work for a participant or ticket."
    ; search_terms = [ "open questions"; "assigned requests" ]
    ; related = [ "request.ask"; "request.get"; "request.resolve" ]
    }
  ; { name = "request.metadata"
    ; summary = "Update supported request metadata under its revision guard."
    ; use_when =
        "A request's descriptive or deadline metadata changes while its lifecycle \
         remains explicit."
    ; search_terms = [ "edit request"; "deadline" ]
    ; related = [ "request.ask"; "request.get"; "request.list"; "request.resolve" ]
    }
  ; { name = "request.reassign"
    ; summary =
        "Change or clear accepted request responsibility under its current revision \
         guard, preserving its resolver."
    ; use_when =
        "The designated resolver must assign responsibility to a frozen delivery \
         recipient or clear it."
    ; search_terms = [ "reassign responsibility"; "route task" ]
    ; related = [ "request.accept"; "request.get"; "request.resolve" ]
    }
  ; { name = "request.resolve"
    ; summary =
        "Resolve a request as its designated resolver, optionally attaching an exact \
         answer atomically."
    ; use_when = "The accountable question or task has an answer or completed resolution."
    ; search_terms = [ "answer question"; "close request" ]
    ; related = [ "request.get"; "request.wait"; "inbox.ack" ]
    }
  ; { name = "reservation.acquire"
    ; summary =
        "Atomically acquire a batch of named shared or exclusive reservations for a \
         registered run."
    ; use_when =
        "Cooperating work needs actual fenced ownership of resources such as a test \
         database."
    ; search_terms = [ "database mutex"; "acquire lock" ]
    ; related = [ "reservation.contention"; "reservation.wait"; "reservation.release" ]
    }
  ; { name = "reservation.contention"
    ; summary =
        "Read actual holders and advisory waiters or expected-release notes without \
         granting ownership."
    ; use_when =
        "You need to understand who holds a named resource or overlapping path and who \
         reports waiting."
    ; search_terms = [ "who holds lock"; "waiters"; "lock contention" ]
    ; related =
        [ "reservation.waiter.put"; "reservation.holder_note.put"; "reservation.acquire" ]
    }
  ; { name = "reservation.get"
    ; summary = "Read one named reservation's retained holders and ownership metadata."
    ; use_when = "You need exact holder tokens and lease state for a shared resource."
    ; search_terms = [ "named lock holders" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.holder_note.put"
    ; summary =
        "Set or clear an advisory note under the exact current holder fence and note \
         revision."
    ; use_when =
        "A real holder wants to report its expected release time without renewing \
         ownership."
    ; search_terms = [ "expected release"; "holder status" ]
    ; related = [ "reservation.contention"; "reservation.renew"; "reservation.release" ]
    }
  ; { name = "reservation.list"
    ; summary = "List retained named reservations and their recorded holders."
    ; use_when = "You need an inventory of logical shared-resource ownership."
    ; search_terms = [ "named locks inventory" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.path.get"
    ; summary =
        "Read a retained logical path reservation and its current ownership metadata."
    ; use_when =
        "You need the actual path hold and fence before renewal, release or recovery."
    ; search_terms = [ "path holder"; "file fence" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.path.list"
    ; summary =
        "List logical file or subtree reservations under explicit worktree and ownership \
         filters."
    ; use_when =
        "You need to see declared file ownership before editing overlapping source."
    ; search_terms = [ "who owns files"; "path inventory" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.path.recover"
    ; summary =
        "Recover an exact expired logical path hold after the harness stops or isolates \
         its prior execution."
    ; use_when =
        "An abandoned file scope needs guarded ownership recovery, with the old fence \
         preserved in audit."
    ; search_terms = [ "recover file ownership"; "expired path" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.path.release"
    ; summary =
        "Release an owned logical path reservation using its actual fencing token."
    ; use_when =
        "A run has finished work in a file or subtree and must relinquish the declared \
         scope."
    ; search_terms = [ "release file lock" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.path.renew"
    ; summary =
        "Renew an owned timed logical path reservation under its exact lease guards."
    ; use_when =
        "A run still needs its file scope and must extend the lease before expiry."
    ; search_terms = [ "renew path lease" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.paths.acquire"
    ; summary =
        "Atomically acquire a batch of lexical file or subtree scopes for a registered \
         run."
    ; use_when =
        "Cooperating agents need declared source ownership without splitting an atomic \
         path batch."
    ; search_terms =
        [ "reserve files"
        ; "source ownership"
        ; "prevent agents editing same files"
        ; "conflicting edits"
        ]
    ; related =
        [ "reservation.path.list"; "reservation.paths.wait"; "reservation.path.release" ]
    }
  ; { name = "reservation.recover"
    ; summary =
        "Recover an exact expired named hold after the harness stops or isolates its \
         prior execution."
    ; use_when =
        "An abandoned shared resource needs guarded recovery rather than treating expiry \
         as release."
    ; search_terms = [ "recover mutex"; "expired lock" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.release"
    ; summary = "Release an owned named reservation using its actual fencing token."
    ; use_when = "The run has finished using a shared logical resource."
    ; search_terms = [ "unlock database"; "release mutex" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.renew"
    ; summary = "Renew an owned timed named reservation under its exact lease guards."
    ; use_when =
        "The run still needs a named resource and must extend its lease before expiry."
    ; search_terms = [ "renew mutex lease" ]
    ; related =
        [ "reservation.contention"; "reservation.acquire"; "reservation.paths.acquire" ]
    }
  ; { name = "reservation.waiter.put"
    ; summary =
        "Begin, refresh or close an advisory waiter record with its own revision and \
         bounded lifetime."
    ; use_when =
        "A registered run wants to expose contention intent without acquiring a queue \
         position."
    ; search_terms = [ "announce wait"; "waiting for database" ]
    ; related = [ "reservation.contention"; "reservation.wait"; "reservation.acquire" ]
    }
  ; { name = "resource.archive"
    ; summary =
        "Archive resource metadata while preserving immutable content and retained \
         history."
    ; use_when =
        "A document or artifact is no longer active but its evidence versions must \
         remain addressable."
    ; search_terms = [ "retire document" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.brief"
    ; summary =
        "Read a bounded resource summary with exact expansion references and omission \
         counts."
    ; use_when =
        "You need to triage a document or artifact before fetching its full metadata or \
         content."
    ; search_terms = [ "artifact summary"; "document brief" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.finish_upload"
    ; summary =
        "Publish verified staged bytes as an immutable resource version under its \
         metadata guard."
    ; use_when =
        "All upload chunks are present and must become durable addressable content."
    ; search_terms = [ "commit upload"; "publish binary" ]
    ; related = [ "resource.upload"; "upload.status"; "resource.get" ]
    }
  ; { name = "resource.get"
    ; summary = "Read resource metadata, links and immutable content-version descriptors."
    ; use_when =
        "You need the metadata guard or an exact content pin before reading or updating \
         a resource."
    ; search_terms = [ "metadata revision"; "content versions" ]
    ; related = [ "resource.list"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.history"
    ; summary = "Read retained resource metadata and publication history."
    ; use_when =
        "You need to trace artifact changes while distinguishing metadata revisions from \
         content versions."
    ; search_terms = [ "artifact revisions" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.link"
    ; summary =
        "Attach an existing resource to a supported planning entity under guarded \
         metadata."
    ; use_when =
        "Published evidence or context should be discoverable from the relevant work."
    ; search_terms = [ "attach artifact"; "link document" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.list"
    ; summary = "List resource metadata under explicit scope, link and archive filters."
    ; use_when = "You need to find documents or artifacts without loading their bytes."
    ; search_terms = [ "artifact inventory"; "find document" ]
    ; related = [ "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.put_text"
    ; summary =
        "Publish immutable UTF-8 content with required creation title and retained \
         metadata."
    ; use_when =
        "A small document or log fits the 65536-byte text limit and needs a versioned \
         resource."
    ; search_terms = [ "publish note"; "save text" ]
    ; related = [ "resource.publish_text"; "resource.upload"; "resource.get" ]
    }
  ; { name = "resource.read"
    ; summary =
        "Read complete UTF-8 content up to 65536 bytes from an immutable resource \
         version."
    ; use_when = "You need the full small text body rather than a range or metadata only."
    ; search_terms = [ "read document"; "small text" ]
    ; related = [ "resource.read_text"; "resource.read_chunk"; "resource.download" ]
    }
  ; { name = "resource.read_chunk"
    ; summary = "Read a verified binary byte range by resource ID and immutable version."
    ; use_when = "A binary or large resource must be retrieved in bounded exact chunks."
    ; search_terms = [ "binary bytes"; "download chunk" ]
    ; related = [ "resource.download"; "resource.read_text"; "resource.get" ]
    }
  ; { name = "resource.read_text"
    ; summary =
        "Read a bounded UTF-8 text range with byte-correct continuation and immutable \
         version or digest."
    ; use_when =
        "A text resource exceeds the complete-read limit or only one range is needed."
    ; search_terms = [ "large text"; "read log range" ]
    ; related = [ "resource.read"; "resource.read_chunk"; "resource.download" ]
    }
  ; { name = "resource.unlink"
    ; summary =
        "Remove a resource's planning-entity attachment while preserving its content."
    ; use_when =
        "An artifact should no longer appear on that work item but must remain retained."
    ; search_terms = [ "detach artifact" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "resource.update"
    ; summary =
        "Update guarded resource metadata without publishing replacement content bytes."
    ; use_when =
        "A document needs a title, summary or metadata edit rather than a new content \
         version."
    ; search_terms = [ "rename document"; "edit artifact metadata" ]
    ; related = [ "resource.list"; "resource.get"; "resource.put_text"; "resource.read" ]
    }
  ; { name = "restore.cancel"
    ; summary =
        "Cancel a pending restore only before any target is installed or occupied."
    ; use_when =
        "An uninstalled restore intent should release its reservations without deleting \
         files."
    ; search_terms = [ "cancel restore intent" ]
    ; related = [ "initialize" ]
    }
  ; { name = "review.accept"
    ; summary =
        "Accept the current submission only after its configured review and validation \
         gates pass."
    ; use_when =
        "The submitter must finalize acceptance of an exact reviewed generation before \
         completion."
    ; search_terms = [ "accept submission"; "finish review" ]
    ; related = [ "review.gate"; "review.record"; "ticket.finish" ]
    }
  ; { name = "review.gate"
    ; summary =
        "Inspect current submission requirements, reviewer decisions and outstanding \
         gate reasons."
    ; use_when =
        "You need to learn what still prevents an exact generation from being accepted."
    ; search_terms = [ "review blockers"; "missing approval" ]
    ; related = [ "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.list"
    ; summary =
        "List immutable reviewer verdicts with exact submission and evidence references."
    ; use_when =
        "You need to inspect approvals or requested changes for submitted outputs."
    ; search_terms = [ "approval history"; "review decisions" ]
    ; related = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.policy.get"
    ; summary =
        "Read the review projection of a ticket's canonical acceptance policy and its \
         revision."
    ; use_when =
        "You need local reviewer requirements; inspect effective acceptance policy for \
         inherited requirements."
    ; search_terms = [ "reviewer policy" ]
    ; related = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.policy.put"
    ; summary =
        "Update guarded ticket-review requirements while preserving criteria and \
         inherited-policy overrides."
    ; use_when =
        "Work needs named or independent reviewers; weakening existing requirements \
         needs an attributed reason."
    ; search_terms = [ "independent review"; "require reviewer" ]
    ; related = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.record"
    ; summary = "Record an immutable reviewer verdict for an exact submitted generation."
    ; use_when =
        "A reviewer checked the pinned outputs and must formally approve or request \
         changes."
    ; search_terms = [ "approve output"; "request changes"; "verdict" ]
    ; related = [ "review.gate"; "review.submit"; "request.resolve" ]
    }
  ; { name = "review.submission.get"
    ; summary =
        "Read a ticket's current submission generation and frozen manifest and policy \
         binding."
    ; use_when =
        "You need the evidence selection currently presented for review and its \
         submission revision."
    ; search_terms = [ "current submission"; "submission generation" ]
    ; related = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.submission.list"
    ; summary = "List current review submissions under explicit ticket filters."
    ; use_when =
        "You need to discover which tickets currently have evidence submitted for review."
    ; search_terms = [ "current submissions"; "review rounds" ]
    ; related = [ "review.gate"; "review.submit"; "review.record"; "review.accept" ]
    }
  ; { name = "review.submit"
    ; summary =
        "Bind submitted outputs to an exact manifest and active attempt in a new review \
         generation."
    ; use_when =
        "An owner has published its evidence and is ready for configured reviewers to \
         inspect it."
    ; search_terms = [ "submit for review"; "present outputs" ]
    ; related = [ "manifest.publish"; "review.record"; "review.gate" ]
    }
  ; { name = "run.action_acknowledge"
    ; summary = "Acknowledge a selected recorded run-budget action under its exact guard."
    ; use_when =
        "The harness has handled a budget attention action and must record that \
         acknowledgement."
    ; search_terms = [ "budget action handled" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.actions"
    ; summary = "Read recorded budget actions associated with a run."
    ; use_when =
        "The harness needs the outstanding actions caused by its declared run budget."
    ; search_terms = [ "budget actions" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.budget_attention"
    ; summary =
        "Read run-budget attention and the reasons a recorded budget requires action."
    ; use_when =
        "You need to inspect budget pressure before deciding the harness's response."
    ; search_terms = [ "budget exceeded"; "spending alert" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.budget_get"
    ; summary = "Read one run's declared budget policy and independent revision."
    ; use_when = "You need current budget limits or a guard before updating them."
    ; search_terms = [ "run limits"; "attempt budget" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.budget_put"
    ; summary =
        "Create or update guarded run-budget limits for admitted work and reported \
         consumption."
    ; use_when =
        "The harness must install explicit limits before dispatching more work to this \
         invocation."
    ; search_terms = [ "limit attempts"; "run spending policy" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.get"
    ; summary =
        "Read one run's immutable identity, reported lifecycle and entity revision."
    ; use_when = "You need the exact invocation record before a guarded transition."
    ; search_terms = [ "invocation state" ]
    ; related = [ "run.register"; "run.observe" ]
    }
  ; { name = "run.heartbeat"
    ; summary =
        "Record advisory liveness without renewing ownership or requiring a mutation ID."
    ; use_when =
        "The harness wants a lightweight current observation separate from durable \
         progress."
    ; search_terms = [ "advisory liveness"; "heartbeat" ]
    ; related = [ "run.heartbeat_get"; "run.observe"; "ticket.renew_lease" ]
    }
  ; { name = "run.heartbeat_get"
    ; summary = "Read the current and last persisted advisory heartbeat observation."
    ; use_when =
        "You need heartbeat timing while retaining its limited process-liveness meaning."
    ; search_terms = [ "last heartbeat"; "observation age" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.link_session"
    ; summary =
        "Associate an existing imported conversation session with a registered run."
    ; use_when =
        "A real invocation's retained transcript should be discoverable from its \
         coordination record."
    ; search_terms = [ "link transcript" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.list"
    ; summary = "List registered invocations under explicit actor and lifecycle filters."
    ; use_when = "You need to find runs before inspecting their work or reported state."
    ; search_terms = [ "worker inventory" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "run.observe"
    ; summary =
        "Durably record a guarded run observation and caller-reported progress metadata."
    ; use_when =
        "The harness needs a replayable observation rather than only advisory heartbeat \
         state."
    ; search_terms = [ "durable observation"; "worker progress" ]
    ; related = [ "run.heartbeat"; "coordinator.overview"; "run.get" ]
    }
  ; { name = "run.register"
    ; summary =
        "Register an attributed invocation with objective, capabilities and an \
         independent run revision."
    ; use_when =
        "The harness has an actual invocation to record before allocating its work."
    ; search_terms = [ "register worker"; "invocation identity" ]
    ; related = [ "run.get"; "run.observe" ]
    }
  ; { name = "run.transition"
    ; summary =
        "Record a guarded run lifecycle transition without controlling its external \
         process."
    ; use_when =
        "The harness has changed an invocation's reported state and must persist it."
    ; search_terms = [ "finish run"; "cancel run"; "lifecycle" ]
    ; related = [ "run.register"; "run.get"; "run.observe" ]
    }
  ; { name = "search.query"
    ; summary =
        "Search captured planning entities and content with bounded results and coverage \
         metadata."
    ; use_when =
        "You need to locate work or context by text before reading exact sources."
    ; search_terms = [ "find tickets"; "find artifacts"; "search workspace" ]
    ; related = [ "ticket.list"; "resource.list"; "fact.search" ]
    }
  ; { name = "session.append"
    ; summary =
        "Append a validated batch of explicit conversation or tool events to a session."
    ; use_when = "The harness has visible events to import into durable history."
    ; search_terms = [ "import transcript"; "append tool event" ]
    ; related = [ "session.list"; "session.create" ]
    }
  ; { name = "session.archive"
    ; summary =
        "Archive a conversation session while preserving retained events and payloads."
    ; use_when =
        "A transcript is no longer active but its imported history must remain available."
    ; search_terms = [ "retire transcript" ]
    ; related = [ "session.list"; "session.create"; "session.append" ]
    }
  ; { name = "session.create"
    ; summary =
        "Create a durable container for explicitly imported conversation and tool events."
    ; use_when =
        "A harness needs a new transcript session before appending visible events."
    ; search_terms = [ "new transcript" ]
    ; related = [ "session.list"; "session.append" ]
    }
  ; { name = "session.get"
    ; summary = "Read a session's metadata and retained history head."
    ; use_when = "You need the transcript identity and capture before reading its events."
    ; search_terms = [ "session metadata" ]
    ; related = [ "session.list"; "session.create"; "session.append" ]
    }
  ; { name = "session.list"
    ; summary = "List explicitly created history sessions under supported filters."
    ; use_when = "You need to find retained transcripts before traversing their events."
    ; search_terms = [ "find transcript" ]
    ; related = [ "session.create"; "session.append" ]
    }
  ; { name = "status.list"
    ; summary = "List the workspace's named ticket statuses and lifecycle categories."
    ; use_when = "You need valid planning statuses before creating or updating tickets."
    ; search_terms = [ "workflow states"; "available statuses" ]
    ; related = [ "status.put" ]
    }
  ; { name = "status.put"
    ; summary =
        "Create or update guarded ticket-status metadata and its lifecycle category."
    ; use_when =
        "The workspace needs a named workflow status with explicit planning meaning."
    ; search_terms = [ "configure workflow state" ]
    ; related = [ "status.list" ]
    }
  ; { name = "subscription.get"
    ; summary = "Read one notification subscription and its current revision."
    ; use_when =
        "You need exact routing selectors before changing notification preferences."
    ; search_terms = [ "routing selectors" ]
    ; related = [ "subscription.list"; "subscription.put" ]
    }
  ; { name = "subscription.list"
    ; summary = "List retained notification subscriptions under explicit filters."
    ; use_when = "You need to inspect which participants subscribed to scoped events."
    ; search_terms = [ "watch subscriptions" ]
    ; related = [ "subscription.get"; "subscription.put" ]
    }
  ; { name = "subscription.put"
    ; summary = "Create or update guarded notification routing preferences."
    ; use_when = "A participant should receive selected discussion or request changes."
    ; search_terms = [ "follow discussion"; "subscribe notifications" ]
    ; related = [ "subscription.list"; "subscription.get" ]
    }
  ; { name = "team.get"
    ; summary = "Read a team and its explicitly recorded actor members."
    ; use_when = "You need the current group before using it as a routing target."
    ; search_terms = [ "team membership" ]
    ; related = [ "team.list"; "team.put" ]
    }
  ; { name = "team.list"
    ; summary = "List named actor teams and their routing metadata."
    ; use_when =
        "You need to discover recipient groups before sending a message or request."
    ; search_terms = [ "recipient groups" ]
    ; related = [ "team.get"; "team.put" ]
    }
  ; { name = "team.put"
    ; summary = "Create or update guarded team metadata and explicit actor membership."
    ; use_when =
        "A durable named recipient group must be maintained for cooperative routing."
    ; search_terms = [ "define team"; "group members" ]
    ; related = [ "team.list"; "team.get" ]
    }
  ; { name = "template.get"
    ; summary = "Read a complete registered template at its exact pinned content version."
    ; use_when = "You need the canonical graph recipe before instantiating it."
    ; search_terms = [ "graph recipe"; "template version" ]
    ; related = [ "template.list"; "template.instantiate" ]
    }
  ; { name = "template.instance_get"
    ; summary = "Read an immutable template instance and its generated ticket plan."
    ; use_when =
        "You need the recorded expansion and placement bindings for an existing instance."
    ; search_terms = [ "generated plan" ]
    ; related = [ "template.list"; "template.get"; "template.instantiate" ]
    }
  ; { name = "template.instance_list"
    ; summary = "List immutable template instances in stable instance-ID order."
    ; use_when = "You need to find prior expansions of repeatable graph recipes."
    ; search_terms = [ "instantiated plans" ]
    ; related = [ "template.list"; "template.get"; "template.instantiate" ]
    }
  ; { name = "template.instance_register"
    ; summary =
        "Validate and register a deterministic template instance against an already \
         existing graph."
    ; use_when =
        "Tickets already exist and their exact deterministic expansion needs a retained \
         instance record."
    ; search_terms = [ "register existing graph" ]
    ; related = [ "template.list"; "template.get"; "template.instantiate" ]
    }
  ; { name = "template.instantiate"
    ; summary =
        "Expand a pinned canonical template into tickets, dependencies and declared \
         policies atomically."
    ; use_when =
        "A repeatable work graph must be created with explicit project, milestone and \
         parent placement."
    ; search_terms = [ "create work graph"; "repeat plan" ]
    ; related = [ "template.list"; "template.get" ]
    }
  ; { name = "template.list"
    ; summary = "List registered immutable template versions."
    ; use_when =
        "You need to find a reusable graph specification before selecting an exact \
         version."
    ; search_terms = [ "available recipes" ]
    ; related = [ "template.get"; "template.instantiate" ]
    }
  ; { name = "template.register"
    ; summary =
        "Register a canonical graph specification pinned to matching published resource \
         bytes and digest."
    ; use_when =
        "The exact specification resource already exists and must become an immutable \
         template version."
    ; search_terms = [ "register recipe"; "canonical spec" ]
    ; related = [ "template.list"; "template.get"; "template.instantiate" ]
    }
  ; { name = "thread.attach"
    ; summary =
        "Attach an existing comment to a guarded discussion thread in its board scope."
    ; use_when =
        "An existing comment should join the thread's append-only discussion attachments."
    ; search_terms = [ "discussion attachment" ]
    ; related = [ "thread.list"; "thread.get"; "thread.reply" ]
    }
  ; { name = "thread.get"
    ; summary =
        "Read a thread's metadata, references and optional bounded current messages."
    ; use_when =
        "You need discussion context while distinguishing current text from pinned \
         request bodies."
    ; search_terms = [ "read discussion" ]
    ; related = [ "thread.list"; "thread.reply" ]
    }
  ; { name = "thread.history"
    ; summary = "Read retained attributed thread metadata revisions."
    ; use_when =
        "You need to trace how a discussion's participants, links or policy changed."
    ; search_terms = [ "discussion revisions" ]
    ; related = [ "thread.list"; "thread.get"; "thread.reply" ]
    }
  ; { name = "thread.list"
    ; summary = "List threads under explicit board and planning-scope filters."
    ; use_when = "You need to find discussions attached to work or organized on a board."
    ; search_terms = [ "find discussion" ]
    ; related = [ "thread.get"; "thread.reply" ]
    }
  ; { name = "thread.pin_message"
    ; summary = "Pin or unpin an already attached comment in a guarded discussion thread."
    ; use_when =
        "A particular retained discussion comment should be pinned separately from the \
         thread's board-level pinned flag."
    ; search_terms = [ "pin discussion comment" ]
    ; related = [ "thread.list"; "thread.get"; "thread.reply" ]
    }
  ; { name = "thread.put"
    ; summary =
        "Create a discussion thread at revision zero or update its guarded metadata."
    ; use_when =
        "A board needs a new topic or an existing topic's participants and metadata must \
         change."
    ; search_terms = [ "create discussion"; "edit thread" ]
    ; related = [ "thread.list"; "thread.get"; "thread.reply" ]
    }
  ; { name = "thread.reply"
    ; summary = "Publish an attributed reply into a guarded discussion thread."
    ; use_when = "A participant needs to continue a durable conversation."
    ; search_terms = [ "reply discussion" ]
    ; related = [ "thread.list"; "thread.get" ]
    }
  ; { name = "thread.search"
    ; summary =
        "Search discussion thread titles with bounded results and explicit scope filters."
    ; use_when = "You need to locate a topic by its title rather than its thread ID."
    ; search_terms = [ "find discussion text" ]
    ; related = [ "thread.list"; "thread.get"; "thread.reply" ]
    }
  ; { name = "ticket.amendment.acknowledge"
    ; summary =
        "Acknowledge an exact instruction-amendment revision under the current ticket \
         claim."
    ; use_when =
        "The current claimant has read revised instructions and must satisfy its \
         completion acknowledgement."
    ; search_terms = [ "acknowledge instructions" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.acknowledgements"
    ; summary = "List exact amendment acknowledgements and their claim bindings."
    ; use_when =
        "You need to check who acknowledged which instruction revision under which \
         ownership token."
    ; search_terms = [ "instruction receipt audit" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.get"
    ; summary =
        "Read an exact immutable instruction amendment with its current withdrawal state."
    ; use_when =
        "You need the authoritative changed instructions before acting or acknowledging \
         them."
    ; search_terms = [ "read new instructions" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.history"
    ; summary =
        "Read retained immutable revisions and lifecycle history of an instruction \
         amendment."
    ; use_when = "You need to trace how an amendment evolved or was explicitly withdrawn."
    ; search_terms = [ "instruction change history" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.list"
    ; summary =
        "List captured ticket instruction amendments with whole-record pagination."
    ; use_when = "You need to discover all revised instructions relevant to a ticket."
    ; search_terms = [ "pending instructions"; "amendment list" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.publish"
    ; summary = "Publish an attributed immutable revision of changed ticket instructions."
    ; use_when =
        "An active or future claimant needs explicit new requirements without silently \
         rewriting history."
    ; search_terms = [ "change instructions"; "new requirements" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.amendment.withdraw"
    ; summary =
        "Explicitly withdraw an instruction amendment under its exact revision guard."
    ; use_when =
        "Previously issued changed instructions should no longer require acknowledgement."
    ; search_terms = [ "withdraw instructions" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.archive"
    ; summary =
        "Archive an eligible ticket while retaining its planning record and history."
    ; use_when =
        "Inactive work should leave ordinary lists without deleting evidence or prior \
         activity."
    ; search_terms = [ "retire ticket" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.blockers"
    ; summary =
        "Read captured reasons currently blocking a ticket's readiness or completion."
    ; use_when =
        "You need a direct explanation of holds, prerequisites or other blocking rules."
    ; search_terms = [ "why blocked"; "blocked task" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.brief"
    ; summary =
        "Read a bounded ticket summary with exact expansion references and omission \
         counts."
    ; use_when =
        "You need to triage work before retrieving its full instructions and related \
         context."
    ; search_terms = [ "task summary"; "brief task" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.claim"
    ; summary =
        "Acquire logical ticket ownership and its fencing token without starting an \
         attempt."
    ; use_when =
        "A run needs an explicit claim before separately recording its execution attempt."
    ; search_terms = [ "claim task"; "acquire ownership" ]
    ; related = [ "ticket.start"; "attempt.start"; "ticket.release" ]
    }
  ; { name = "ticket.claim_next"
    ; summary =
        "Atomically select and claim eligible work; a standalone empty observation \
         writes nothing."
    ; use_when =
        "A registered worker should take the next admitted task without a \
         read-then-claim race."
    ; search_terms = [ "next task"; "dispatch work" ]
    ; related = [ "ticket.ready"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.complete"
    ; summary =
        "Complete claimed work with nonempty evidence, finishing active attempts and \
         clearing ownership."
    ; use_when =
        "The owner can satisfy all current gates and needs completion without \
         ticket.finish's handoff input."
    ; search_terms = [ "mark done"; "complete task" ]
    ; related = [ "ticket.finish"; "ticket.readiness"; "review.gate" ]
    }
  ; { name = "ticket.context"
    ; summary =
        "Read captured ticket instructions, ownership, links, handoff and related \
         context."
    ; use_when =
        "You need captured task context before starting or recovering work; inspect \
         omissions before assuming it is complete."
    ; search_terms = [ "read task context"; "ticket.get" ]
    ; related = [ "ticket.list"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.create"
    ; summary =
        "Create a ticket with explicit instructions, placement and planning metadata."
    ; use_when = "A new unit of work must be added to the durable plan."
    ; search_terms = [ "new task"; "new issue" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.finish"
    ; summary = "Record completion evidence and finish an active attempt atomically."
    ; use_when =
        "The current owner has finished and wants one durable transition for ticket and \
         active try."
    ; search_terms = [ "finish task"; "completion evidence" ]
    ; related = [ "ticket.complete"; "review.gate"; "handoff.set" ]
    }
  ; { name = "ticket.hierarchy.get"
    ; summary = "Read stored hierarchy policy and the effective flat-plan defaults."
    ; use_when =
        "You need to understand how parent and child relationships affect planning gates."
    ; search_terms = [ "parent child rules" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.hierarchy.put"
    ; summary = "Create or update guarded parent-child planning policy."
    ; use_when =
        "A hierarchy needs explicit behavior for child completion or prerequisite \
         inheritance."
    ; search_terms = [ "configure hierarchy"; "parent rules" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.hold"
    ; summary = "Set a ticket hold reason or lift the hold with JSON null."
    ; use_when = "Work must be paused or explicitly unpaused without changing its status."
    ; search_terms = [ "pause task"; "unhold" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.list"
    ; summary =
        "List tickets under explicit project, status, assignment and other planning \
         filters."
    ; use_when =
        "You need to find work before selecting an exact ticket or checking readiness."
    ; search_terms = [ "find tasks"; "issue list" ]
    ; related = [ "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.metadata"
    ; summary =
        "Update guarded priority, assignee, labels, acceptance criteria or status."
    ; use_when =
        "Planning classification or assignment must change without claiming execution \
         ownership."
    ; search_terms = [ "priority"; "assign task"; "labels" ]
    ; related = [ "ticket.update"; "ticket.reassign"; "ticket.read" ]
    }
  ; { name = "ticket.move"
    ; summary =
        "Move a ticket between supported project, milestone or parent placements under \
         guards."
    ; use_when =
        "Work belongs in a different part of the plan and placement invariants must hold."
    ; search_terms = [ "reparent task"; "move project" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.paths.get"
    ; summary = "Read a ticket's declared required logical path-ownership policy."
    ; use_when =
        "You need to know which file scopes a run must own before acquiring this work."
    ; search_terms = [ "required files"; "ownership policy" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.paths.list"
    ; summary = "List declared ticket path requirements under explicit filters."
    ; use_when =
        "You need to inspect file-scope admission requirements across planned work."
    ; search_terms = [ "file requirements" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.paths.put"
    ; summary = "Install guarded required logical file or subtree ownership for a ticket."
    ; use_when =
        "A task must require a registered run to hold declared source scopes before \
         admission."
    ; search_terms = [ "require path ownership" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.progress"
    ; summary = "Append an attributed progress comment under current ticket ownership."
    ; use_when =
        "The current owner needs to record a meaningful checkpoint without finishing the \
         task."
    ; search_terms = [ "status update"; "progress report" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.read"
    ; summary =
        "Read complete instructions, acceptance criteria and ownership without related \
         histories."
    ; use_when =
        "You need the authoritative task body with a smaller response than \
         ticket.context."
    ; search_terms = [ "full instructions"; "task description" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.readiness"
    ; summary =
        "Explain graph readiness and optional candidate or registered-run admission \
         checks."
    ; use_when =
        "You need to know whether and why a particular worker can acquire this task."
    ; search_terms = [ "can start"; "eligibility"; "why blocked" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.start" ]
    }
  ; { name = "ticket.ready"
    ; summary =
        "List graph-ready work or candidate/run-admissible tickets under explicit \
         selectors."
    ; use_when =
        "You need eligible tasks before actual acquisition, without creating ownership."
    ; search_terms = [ "available work"; "ready queue" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.reassign"
    ; summary =
        "Transfer or release an existing ticket claim with a fresh ownership fence and \
         explicit reason."
    ; use_when =
        "The plan needs to change a claimant after active attempts finish, using the \
         exact ticket revision."
    ; search_terms = [ "transfer claim"; "change owner" ]
    ; related = [ "ticket.metadata"; "ticket.release"; "ticket.context" ]
    }
  ; { name = "ticket.recover"
    ; summary =
        "Recover an exact expired claim with explicit disposition after the harness \
         stops or isolates prior execution."
    ; use_when =
        "Abandoned work needs safe guarded requeue or retained-state recovery rather \
         than assumed process termination."
    ; search_terms = [ "recover task"; "requeue abandoned work" ]
    ; related = [ "ticket.recovery.get"; "ticket.context"; "ticket.resume" ]
    }
  ; { name = "ticket.recovery.get"
    ; summary = "Read one immutable guarded ticket-recovery audit record."
    ; use_when =
        "You need the exact old claim, selected disposition and effects of a prior \
         recovery."
    ; search_terms = [ "ticket recovery audit" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.recovery.list"
    ; summary =
        "List immutable ticket-recovery records under one guarded workspace capture."
    ; use_when =
        "You need to inspect prior ticket recoveries and their explicit requeue \
         decisions."
    ; search_terms = [ "requeue history" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.release"
    ; summary =
        "Release current ticket ownership, return work to Todo and cancel active \
         attempts with release evidence."
    ; use_when =
        "The actual owner is yielding the task without declaring completion, including \
         an expired own claim."
    ; search_terms = [ "yield task"; "release claim" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.renew_lease"
    ; summary = "Renew a timed ticket claim under its exact token and lease revision."
    ; use_when = "The owner must extend valid logical ownership while work continues."
    ; search_terms = [ "renew claim"; "extend lease" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.reopen"
    ; summary = "Reopen eligible completed work under its current planning guards."
    ; use_when = "Previously completed work must become active planning work again."
    ; search_terms = [ "reopen task" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.resolve"
    ; summary = "Resolve a human-facing display key to its canonical ticket ID."
    ; use_when =
        "You have a key such as WG-1 and need the internal ID accepted by other methods."
    ; search_terms = [ "display key"; "issue number" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "ticket.resume"
    ; summary =
        "Recover bounded recorded task context with exact historical source references."
    ; use_when =
        "A new invocation must resume work from retained instructions, handoffs and \
         activity."
    ; search_terms = [ "resume task"; "restore context" ]
    ; related = [ "handoff.get"; "activity.digest"; "ticket.context" ]
    }
  ; { name = "ticket.start"
    ; summary = "Claim a ready ticket and optionally start an attempt atomically."
    ; use_when =
        "A worker is beginning known work and needs actual ownership before acting."
    ; search_terms = [ "begin task"; "start work" ]
    ; related = [ "ticket.readiness"; "ticket.claim_next"; "ticket.progress" ]
    }
  ; { name = "ticket.update"
    ; summary =
        "Update guarded title, description or status; use ticket.metadata for priority."
    ; use_when =
        "A ticket's primary instructions or supported status needs an explicit edit."
    ; search_terms = [ "edit instructions"; "rename task" ]
    ; related = [ "ticket.list"; "ticket.context"; "ticket.readiness"; "ticket.start" ]
    }
  ; { name = "transaction.apply"
    ; summary =
        "Commit 1..128 ordered planning operations atomically with typed creation \
         aliases."
    ; use_when =
        "A coherent plan, coupled policy or publication-and-link operation must publish \
         together."
    ; search_terms = [ "atomic batch"; "all or nothing" ]
    ; related = [ "transaction.preflight"; "template.instantiate" ]
    }
  ; { name = "transaction.preflight"
    ; summary =
        "Validate an atomic plan using actual domain preparation without committing it."
    ; use_when =
        "You need to check a coupled plan and its guards before submitting the durable \
         write."
    ; search_terms = [ "preview plan"; "dry run" ]
    ; related = [ "transaction.apply"; "ticket.readiness" ]
    }
  ; { name = "upload.abort"
    ; summary = "Discard actor-owned private upload staging and free its admission."
    ; use_when =
        "An unfinished upload is abandoned and should release its ephemeral staging \
         capacity."
    ; search_terms = [ "abort upload"; "clear staging" ]
    ; related = [ "upload.begin"; "upload.status"; "upload.chunk" ]
    }
  ; { name = "upload.begin"
    ; summary =
        "Begin or resume actor-owned ephemeral byte staging with declared content \
         metadata."
    ; use_when =
        "A large or binary resource needs a staged upload before immutable publication."
    ; search_terms = [ "start binary upload" ]
    ; related = [ "upload.status"; "upload.chunk" ]
    }
  ; { name = "upload.chunk"
    ; summary = "Stage a contiguous opaque byte chunk or retry an identical byte range."
    ; use_when =
        "An admitted upload needs its next exact bytes without changing already staged \
         content."
    ; search_terms = [ "send upload bytes" ]
    ; related = [ "upload.begin"; "upload.status" ]
    }
  ; { name = "upload.list"
    ; summary =
        "Inspect complete live upload owner, progress, lifecycle and age metadata."
    ; use_when =
        "You need to locate abandoned or incomplete private staging for explicit cleanup."
    ; search_terms = [ "upload inventory"; "abandoned staging" ]
    ; related = [ "upload.begin"; "upload.status"; "upload.chunk" ]
    }
  ; { name = "upload.status"
    ; summary = "Read one actor-owned live upload's contiguous progress and lifecycle."
    ; use_when = "You need the current staged byte position before continuing an upload."
    ; search_terms = [ "upload offset"; "staging progress" ]
    ; related = [ "upload.begin"; "upload.chunk" ]
    }
  ; { name = "usage.aggregate"
    ; summary =
        "Aggregate immutable caller-reported usage and named integer samples in one \
         capture."
    ; use_when =
        "You need bounded consumption totals over explicitly selected reported records."
    ; search_terms = [ "usage totals"; "cost report" ]
    ; related = [ "usage.report"; "usage.list" ]
    }
  ; { name = "usage.list"
    ; summary =
        "List immutable caller-reported usage records under explicit scope filters."
    ; use_when =
        "You need the individual consumption reports behind budget or metrics totals."
    ; search_terms = [ "usage ledger" ]
    ; related = [ "usage.aggregate"; "usage.report" ]
    }
  ; { name = "usage.report"
    ; summary =
        "Record an immutable attributed consumption report and supported named integer \
         samples."
    ; use_when =
        "A harness has measured usage that must become durable coordination evidence."
    ; search_terms = [ "report tokens"; "report cost" ]
    ; related = [ "usage.aggregate"; "usage.list" ]
    }
  ; { name = "validation.add"
    ; summary = "Record an attributed validator outcome against exact pinned evidence."
    ; use_when =
        "A required check has run externally and its immutable result must satisfy the \
         configured gate."
    ; search_terms = [ "record test result"; "validator verdict" ]
    ; related = [ "validation.list" ]
    }
  ; { name = "validation.list"
    ; summary = "List recorded checks and their exact evidence bindings."
    ; use_when =
        "You need to inspect whether the required validators checked the submitted \
         artifacts."
    ; search_terms = [ "check results"; "test evidence" ]
    ; related = [ "validation.add" ]
    }
  ; { name = "workspace.archive"
    ; summary =
        "Archive guarded workspace planning metadata while retaining its durable \
         contents."
    ; use_when =
        "A workspace's planning collection should be marked inactive without \
         unregistering or deleting it."
    ; search_terms = [ "retire workspace" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.close"
    ; summary =
        "Close a loaded workspace and checkpoint its planning and history heads while \
         retaining registration."
    ; use_when =
        "The tree must be handed off, copied or reopened for recovery with one writer at \
         a time."
    ; search_terms = [ "close before copy"; "handoff workspace" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.create"
    ; summary =
        "Create, register and open a new durable workspace at a fresh private root."
    ; use_when = "A new independent planning collection needs initial local setup."
    ; search_terms = [ "new workspace"; "setup" ]
    ; related = [ "workspace.list"; "workspace.overview" ]
    }
  ; { name = "workspace.export"
    ; summary =
        "Start an immutable captured workspace export while normal writes may continue."
    ; use_when = "You need a portable backup of planning, resources and imported history."
    ; search_terms = [ "backup workspace"; "snapshot" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.get"
    ; summary = "Read workspace planning metadata and its current entity revision."
    ; use_when = "You need the exact name, instructions and guard before a metadata edit."
    ; search_terms = [ "workspace instructions" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.list"
    ; summary =
        "List registry workspaces with open intent, availability and explicit name \
         provenance."
    ; use_when =
        "You need to discover registered workspaces without opening or probing their \
         closed roots."
    ; search_terms = [ "registered workspaces"; "available collections" ]
    ; related = [ "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.metrics"
    ; summary =
        "Observe committed activity, reported usage and exact admission accounting."
    ; use_when =
        "You need recorded work metrics without inferring client calls or process \
         behavior."
    ; search_terms = [ "workspace statistics"; "capacity metrics" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.open"
    ; summary =
        "Replay and verify a closed registered workspace before serving scoped \
         operations."
    ; use_when =
        "The local registration exists and its portable tree must become available again."
    ; search_terms = [ "open collection"; "replay workspace" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.overview"
    ; summary = "Read a bounded captured workspace summary and its open work."
    ; use_when = "You need a starting overview before narrowing to a project or ticket."
    ; search_terms = [ "workspace dashboard"; "open tasks" ]
    ; related = [ "workspace.list"; "workspace.create" ]
    }
  ; { name = "workspace.receipt"
    ; summary = "Read a workspace-planning mutation's exact durable saved receipt."
    ; use_when =
        "A planning write's outcome is uncertain and current entity state cannot \
         establish its original result."
    ; search_terms = [ "planning receipt"; "uncertain mutation" ]
    ; related = [ "registry.receipt"; "retry"; "journal.inspect" ]
    }
  ; { name = "workspace.register"
    ; summary = "Verify and register an existing portable workspace tree, then open it."
    ; use_when =
        "You have an existing current-format tree to attach to this local daemon."
    ; search_terms = [ "attach workspace"; "import tree" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.restore"
    ; summary =
        "Verify, copy and replay a complete export into a fresh root, registering the \
         result closed."
    ; use_when =
        "A portable backup must become a restored workspace before an explicit open."
    ; search_terms = [ "restore backup"; "recover workspace" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.unregister"
    ; summary =
        "Remove a closed workspace's local registry association while leaving portable \
         files intact."
    ; use_when =
        "The daemon should stop managing that local registration without deleting its \
         data."
    ; search_terms = [ "detach workspace"; "remove registration" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ; { name = "workspace.update"
    ; summary =
        "Update guarded workspace planning name, summary, description or instructions."
    ; use_when =
        "Shared workspace metadata changes without changing its local registry path."
    ; search_terms = [ "rename workspace"; "workspace instructions" ]
    ; related = [ "workspace.list"; "workspace.overview"; "workspace.create" ]
    }
  ]
;;

let helpers : Helper.t list =
  [ { name = "request.wait"
    ; summary =
        "Poll one request locally until a complete resolved observation or a bounded \
         stop."
    ; use_when =
        "You need to wait for an accountable answer without asking again or \
         acknowledging delivery."
    ; search_terms = [ "wait answer"; "poll question" ]
    ; capability = "communication"
    ; effect_summary = "Local read helper; no daemon method or persistent worker."
    ; reference = "references/communication-evidence.md"
    }
  ; { name = "journal.inspect"
    ; summary =
        "Inspect one exact saved request's identity, hashes and receipt namespace \
         offline."
    ; use_when = "You need to understand a saved attempt before choosing an exact retry."
    ; search_terms = [ "saved request"; "request hash"; "uncertain write" ]
    ; capability = "recovery"
    ; effect_summary =
        "Offline read; saved attempts prove neither transmission nor commit."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "journal.list"
    ; summary =
        "List a bounded nonrecursive directory of saved requests and group matching or \
         conflicting identities."
    ; use_when =
        "You need to audit saved attempts without contacting the daemon or replaying \
         writes."
    ; search_terms = [ "saved requests"; "duplicate requests"; "journal audit" ]
    ; capability = "recovery"
    ; effect_summary =
        "Offline read; scan completeness and commit status remain explicit."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "fields"
    ; summary =
        "Inspect offline request-field descriptors and the original validation schema."
    ; use_when =
        "You need the exact arguments for a method before constructing a request."
    ; search_terms = [ "arguments"; "parameters"; "schema"; "input fields" ]
    ; capability = "administration"
    ; effect_summary =
        "Offline schema inspection; flat fields do not replace cross-field validation."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "template.publish"
    ; summary =
        "Canonicalize a small graph specification and atomically publish its resource \
         and template registration."
    ; use_when =
        "You want a repeatable work recipe without manually calculating its exact \
         content pin."
    ; search_terms = [ "publish template"; "canonical graph"; "recipe" ]
    ; capability = "planning"
    ; effect_summary =
        "Local helper expands one saved transaction.apply; no new daemon method."
    ; reference = "references/coordination.md"
    }
  ; { name = "resource.publish_text"
    ; summary = "Atomically publish small immutable text and attach it to a ticket."
    ; use_when =
        "A new note or artifact must appear on its ticket in the same durable \
         transaction."
    ; search_terms = [ "publish and link"; "attach text"; "save note" ]
    ; capability = "context"
    ; effect_summary =
        "Local helper expands one saved transaction.apply; publication is not approval."
    ; reference = "references/resources.md"
    }
  ; { name = "init"
    ; summary =
        "Create or resume explicit local setup through the bootstrap CLI workflow."
    ; use_when =
        "You need connection context and workspace setup before beginning the first \
         ticket."
    ; search_terms = [ "setup"; "bootstrap"; "context file" ]
    ; capability = "administration"
    ; effect_summary =
        "Local setup workflow; inspect init help for filesystem and daemon operations."
    ; reference = "references/getting-started.md"
    }
  ; { name = "reservation.wait"
    ; summary =
        "Run bounded foreground retries for an atomic named-resource acquisition after \
         typed contention."
    ; use_when =
        "A cooperating run must wait for a shared database or other named resource, \
         preserving exact uncertain requests."
    ; search_terms = [ "wait database"; "wait mutex"; "lock wait" ]
    ; capability = "coordination"
    ; effect_summary =
        "Local acquisition workflow; no fairness queue, renewal or process supervision."
    ; reference = "references/coordination.md"
    }
  ; { name = "reservation.paths.wait"
    ; summary =
        "Run bounded foreground retries for an atomic logical path acquisition after \
         typed contention."
    ; use_when =
        "A cooperating run must wait for overlapping file scopes without splitting its \
         requested batch."
    ; search_terms = [ "wait files"; "wait source ownership"; "path lock" ]
    ; capability = "coordination"
    ; effect_summary =
        "Local acquisition workflow; grants remain logical and uncertain writes keep \
         exact identity."
    ; reference = "references/path-conditions-recovery.md"
    }
  ; { name = "receipts"
    ; summary =
        "Explain method-specific durable results, revisions and exact retry handling."
    ; use_when =
        "A script must extract actual output fields without confusing counter namespaces."
    ; search_terms = [ "result fields"; "JSON paths"; "revision counters" ]
    ; capability = "administration"
    ; effect_summary = "Offline reference; no request is transmitted."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "pagination"
    ; summary =
        "Explain bounded local traversal, independent captures and resumable \
         continuation requests."
    ; use_when =
        "A supported list must be read beyond one page without silently refreshing its \
         capture."
    ; search_terms = [ "next page"; "all results"; "cursor"; "complete list" ]
    ; capability = "observation"
    ; effect_summary =
        "Local read traversal guidance; incomplete limits stay explicit and \
         notifications are never acknowledged."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "evidence"
    ; summary =
        "List the local captured-execution inspection, publication and cleanup helpers."
    ; use_when = "You need to choose the next step in retaining command evidence."
    ; search_terms = [ "command evidence"; "capture output" ]
    ; capability = "verification"
    ; effect_summary =
        "Offline helper index; actual execution and publication are explicit separate \
         helpers."
    ; reference = "references/execution.md"
    }
  ; { name = "evidence.show"
    ; summary = "Inspect a bounded retained output range from a local evidence stage."
    ; use_when =
        "You need exact captured stdout or stderr bytes and truncation coverage without \
         rerunning the command."
    ; search_terms = [ "stdout"; "stderr"; "log tail"; "inspect capture" ]
    ; capability = "verification"
    ; effect_summary = "Local read; no execution, publication or daemon access."
    ; reference = "references/execution.md"
    }
  ; { name = "evidence.clean"
    ; summary =
        "Clean one finished validated evidence stage using its actual ownership token."
    ; use_when =
        "An owned local capture is no longer needed and has no unresolved publication \
         intent."
    ; search_terms = [ "cleanup capture"; "remove stage" ]
    ; capability = "verification"
    ; effect_summary =
        "Explicit local cleanup; refuses live, unfinished or foreign stages and unknown \
         files."
    ; reference = "references/execution.md"
    }
  ; { name = "evidence-run"
    ; summary =
        "Execute explicit child argv locally and retain bounded output, hashes and \
         declared source coverage."
    ; use_when =
        "A check must run through the harness and produce inspectable capture evidence."
    ; search_terms = [ "run tests"; "capture command"; "stdout"; "source provenance" ]
    ; capability = "verification"
    ; effect_summary =
        "Local process execution; no daemon access and no implied approval or \
         complete-tree proof."
    ; reference = "references/execution.md"
    }
  ; { name = "evidence-publish"
    ; summary =
        "Publish a finished local evidence capture using a saved exact plan without \
         rerunning execution."
    ; use_when =
        "Captured command output must become a durable immutable resource, optionally \
         linked separately to work."
    ; search_terms = [ "publish test results"; "retain logs" ]
    ; capability = "verification"
    ; effect_summary =
        "Local publication workflow; optional ticket linking is a separate recoverable \
         write."
    ; reference = "references/execution.md"
    }
  ; { name = "resource.upload"
    ; summary =
        "Upload a bounded local file as immutable content through an exact saved upload \
         plan."
    ; use_when =
        "A binary or large text artifact must be published beyond the small-text limit."
    ; search_terms = [ "upload file"; "binary artifact"; "large document" ]
    ; capability = "context"
    ; effect_summary =
        "Local staged-upload workflow; optional ticket link is separate from publication."
    ; reference = "references/resources.md"
    }
  ; { name = "resource.upload-abort"
    ; summary =
        "Abort the owner staging identified by an exact saved upload plan without \
         reading its source file."
    ; use_when =
        "An abandoned saved upload should free staging without deleting published bytes \
         or receipts."
    ; search_terms = [ "abort saved upload"; "cleanup upload" ]
    ; capability = "context"
    ; effect_summary =
        "Local write workflow; published content and exact finish receipts remain."
    ; reference = "references/resources.md"
    }
  ; { name = "resource.download"
    ; summary =
        "Download an immutable version with verified chunks and complete digest into a \
         fresh destination."
    ; use_when =
        "You need exact resource bytes as a local file or a deliberately selected byte \
         stream."
    ; search_terms = [ "download file"; "verify digest"; "binary export" ]
    ; capability = "context"
    ; effect_summary =
        "Local filesystem write plus daemon reads; stdout streams can precede a later \
         integrity error unless spooled."
    ; reference = "references/resources.md"
    }
  ; { name = "retry"
    ; summary =
        "Replay an exact saved request or supported upload plan without changing \
         identity or attribution."
    ; use_when =
        "A transmitted write's outcome is uncertain and must be recovered without \
         issuing a new intention."
    ; search_terms =
        [ "uncertain write"; "lost reply"; "idempotency"; "recover mutation" ]
    ; capability = "recovery"
    ; effect_summary =
        "Local replay workflow; saved bytes and original guards remain exact, and \
         evidence commands never rerun."
    ; reference = "references/cli-contract.md"
    }
  ; { name = "migrate"
    ; summary = "Convert a stopped supported older workspace into a verified new root."
    ; use_when =
        "You are upgrading from the supported 0.6.2-era format and need to retain \
         planning, resources and history. Read migration instructions before acting."
    ; search_terms = [ "upgrade workspace"; "convert storage"; "preserve old data" ]
    ; capability = "administration"
    ; effect_summary =
        "Offline local filesystem write; preserves the source and publishes a new \
         destination. Old registry jobs and saved API envelopes are not migrated."
    ; reference = "references/compatibility.md"
    }
  ; { name = "serve"
    ; summary =
        "Run the standalone local daemon with its explicit registry directory and socket."
    ; use_when =
        "You need to start the state service in a separate harness-owned process."
    ; search_terms = [ "start daemon"; "local service" ]
    ; capability = "administration"
    ; effect_summary =
        "Local service process; preserve managed roots, locks and occupied sockets."
    ; reference = "references/administration.md"
    }
  ; { name = "call"
    ; summary =
        "Send a raw exact method and one JSON params object using selected transport \
         defaults."
    ; use_when = "You need the wire-shaped request rather than named parameter expansion."
    ; search_terms = [ "raw JSON"; "RPC"; "exact request" ]
    ; capability = "administration"
    ; effect_summary =
        "Local transport helper; raw params cannot be merged with named field flags."
    ; reference = "references/cli-contract.md"
    }
  ]
;;

let workflows : Workflow.t list =
  [ { id = "plan_work"
    ; title = "Create a coherent work plan"
    ; summary =
        "Prepare tickets, prerequisites and admission policy together before dispatching \
         workers."
    ; use_when =
        "A delivery goal needs multiple related work items whose dependencies and gates \
         must publish consistently."
    ; search_terms =
        [ "plan project"; "atomic plan"; "dependencies"; "dispatch preparation" ]
    ; capability = "planning"
    ; steps =
        [ "Inspect project.get and status.list; read existing entity and policy \
           revisions instead of guessing guards."
        ; "Draft transaction.apply operations for ticket creation, dependency.add and \
           any required allocation.ticket_policy_put; use typed creation aliases within \
           the plan."
        ; "Call transaction.preflight with the proposed operations and inspect blockers; \
           preflight reserves no state."
        ; "Save and submit transaction.apply using one stable mutation identity; retain \
           its actual IDs, revisions and durable receipt before the harness dispatches \
           workers."
        ]
    ; methods =
        [ "project.get"
        ; "status.list"
        ; "ticket.create"
        ; "dependency.add"
        ; "allocation.ticket_policy_put"
        ; "transaction.preflight"
        ; "transaction.apply"
        ]
    ; reference = "references/planning.md"
    }
  ; { id = "work_ticket"
    ; title = "Start, report and finish a ticket"
    ; summary =
        "Record a real invocation, acquire admitted work and retain its actual ownership \
         token through completion."
    ; use_when =
        "A harness has provisioned a worker that needs a durable ticket execution loop."
    ; search_terms = [ "begin task"; "claim work"; "agent loop"; "complete task" ]
    ; capability = "coordination"
    ; steps =
        [ "The harness provisions and supervises the process and checkout; register that \
           actual invocation with run.register and retain its run revision."
        ; "Read ticket.context and ticket.readiness with target_run_id; inspect \
           instructions, amendments, path ownership and policy before acquiring work."
        ; "Save ticket.start for the chosen ticket, or ticket.claim_next for selection, \
           with the actual target run and an attempt ID when recording a try. Inspect \
           the returned kind before using any token."
        ; "Retain the returned ticket token and attempt/lease revisions; record \
           ticket.progress and handoff.set under current ownership, renewing timed \
           ownership explicitly when needed."
        ; "Run the actual work and checks through the harness, satisfy applicable gates, \
           then save ticket.finish with the actual token and concrete evidence. Report \
           only observed completion."
        ]
    ; methods =
        [ "run.register"
        ; "ticket.context"
        ; "ticket.readiness"
        ; "ticket.start"
        ; "ticket.claim_next"
        ; "ticket.progress"
        ; "handoff.set"
        ; "ticket.finish"
        ]
    ; reference = "references/coordination.md"
    }
  ; { id = "ask_question"
    ; title = "Ask and resolve an accountable question"
    ; summary =
        "Create a pinned question, receive its exact answer and keep delivery \
         acknowledgement separate."
    ; use_when =
        "A participant needs an answer from a designated resolver and must retain its \
         provenance."
    ; search_terms =
        [ "ask reviewer"; "wait for answer"; "clarification"; "question answer" ]
    ; capability = "communication"
    ; steps =
        [ "Save request.ask with explicit recipients, resolver_id and body; select a new \
           topic or an existing thread with its actual expected_thread_revision."
        ; "Retain the returned request_id, request_revision and exact question \
           reference; request.ask does not return a generic revision or status."
        ; "The designated resolver reads request.get, retains its current revision and \
           saves request.resolve with that expected_revision and an optional nonblank \
           answer body."
        ; "Read request.get or use the bounded local request.wait helper; inspect \
           status.kind and the exact pinned answer, including a resolved request with \
           answer:null."
        ; "Process inbox delivery separately and acknowledge only the selected handled \
           notifications with inbox.ack; resolution never completes the linked ticket."
        ]
    ; methods =
        [ "request.ask"
        ; "request.get"
        ; "request.resolve"
        ; "request.wait"
        ; "inbox.read"
        ; "inbox.ack"
        ]
    ; reference = "references/communication-evidence.md"
    }
  ; { id = "share_context"
    ; title = "Publish and reuse shared context"
    ; summary =
        "Choose bounded facts or versioned resources and carry exact evidence pins into \
         later work."
    ; use_when =
        "Agents need to share structured context, longer notes or binary artifacts \
         durably."
    ; search_terms =
        [ "shared memory"; "save findings"; "publish document"; "retain context" ]
    ; capability = "context"
    ; steps =
        [ "Use fact.keys or resource.list to discover existing context before creating a \
           duplicate record; expand only selected values or metadata."
        ; "For small JSON values read fact.get and use its actual fact revision with \
           fact.put; JSON null is a value rather than deletion."
        ; "For small UTF-8 text use resource.put_text with the resource metadata guard, \
           or the local resource.publish_text helper when a new ticket link must publish \
           atomically."
        ; "For large or binary bytes use the local resource.upload saved plan; ticket \
           linking in that helper is separate and can require exact recovery."
        ; "Retain the returned immutable content version and digest independently of \
           metadata revision; retrieve exact content through resource.read, \
           resource.read_text or verified resource.download."
        ]
    ; methods =
        [ "fact.keys"
        ; "fact.get"
        ; "fact.put"
        ; "resource.list"
        ; "resource.put_text"
        ; "resource.publish_text"
        ; "resource.upload"
        ; "resource.read"
        ; "resource.read_text"
        ; "resource.download"
        ]
    ; reference = "references/resources.md"
    }
  ; { id = "recover_work"
    ; title = "Recover context and abandoned ownership"
    ; summary =
        "Inspect retained work and exact saved requests before any guarded ownership \
         recovery."
    ; use_when =
        "An invocation ended or became stale and another harness must decide how to \
         resume safely."
    ; search_terms =
        [ "stale worker"
        ; "abandoned task"
        ; "resume after interruption"
        ; "lost reply"
        ; "requeue"
        ]
    ; capability = "recovery"
    ; steps =
        [ "Read ticket.resume and actor.overview or coordinator.overview to recover \
           recorded instructions, handoff, held claims and attempts. Stale observations \
           and expiry never prove process termination."
        ; "For an uncertain write inspect the saved journal and use retry on the exact \
           saved request; do not refresh guards or replace its mutation identity."
        ; "The harness must stop or isolate the old execution and checkout before \
           reclaiming its logical ownership."
        ; "Read current ticket.context or reservation ownership and retain the exact old \
           token, lease revision and other required recovery guards."
        ; "Save ticket.recover with explicit disposition:requeue when work should return \
           to Todo, or use the exact named/path reservation recovery method. Read \
           retained recovery audit before starting replacement work."
        ]
    ; methods =
        [ "ticket.resume"
        ; "actor.overview"
        ; "coordinator.overview"
        ; "journal.inspect"
        ; "retry"
        ; "ticket.context"
        ; "ticket.recover"
        ; "reservation.recover"
        ; "reservation.path.recover"
        ; "ticket.recovery.get"
        ]
    ; reference = "references/path-conditions-recovery.md"
    }
  ; { id = "verify_outputs"
    ; title = "Capture evidence and accept reviewed outputs"
    ; summary =
        "Publish exact output evidence, obtain formal checks and review, then accept and \
         finish the current generation."
    ; use_when =
        "Completed work must satisfy reproducible validation and independent review \
         requirements."
    ; search_terms =
        [ "run tests"
        ; "review output"
        ; "approve submission"
        ; "verify artifact"
        ; "completion evidence"
        ]
    ; capability = "verification"
    ; steps =
        [ "Read the effective acceptance policy and review requirements before running \
           checks; retain the observed policy digest and current claim and attempt \
           binding."
        ; "Run the actual command through the harness, optionally using local \
           evidence-run; inspect its observed outcome, truncation and declared source \
           coverage before publishing with evidence-publish."
        ; "Publish the contract and manifest with exact resource versions and digests; \
           retain the returned manifest revision, then submit it through review.submit \
           as a new generation."
        ; "Record validation.add against the exact manifest and observed policy digest. \
           A distinct configured reviewer inspects those exact outputs and records \
           review.record for the actual generation."
        ; "Inspect review.gate; an approve message alone does not establish acceptance. \
           Resolve changes requests explicitly, resubmit changed outputs as a new \
           generation, and obtain fresh proof."
        ; "For each required acceptance criterion, perform the stated check and record \
           acceptance.assert with its current effective policy digest, exact evidence \
           pins and actual ownership guards. Validation and reviewer verdicts do not \
           replace these assertions."
        ; "When the current generation passes review.gate, save review.accept under the \
           observed submission revision. Inspect ticket.readiness for all remaining \
           completion requirements, then ticket.finish under actual ownership."
        ]
    ; methods =
        [ "acceptance.policy.effective"
        ; "evidence-run"
        ; "evidence-publish"
        ; "contract.put"
        ; "manifest.publish"
        ; "review.submit"
        ; "validation.add"
        ; "review.record"
        ; "review.gate"
        ; "review.accept"
        ; "acceptance.assert"
        ; "ticket.readiness"
        ; "ticket.finish"
        ]
    ; reference = "references/gated-review-workflow.md"
    }
  ; { id = "observe_changes"
    ; title = "Catch up and wait without losing a wakeup"
    ; summary =
        "Use bounded captures and exact continuation positions before parking a worker \
         in a filtered wait."
    ; use_when =
        "A consumer must follow relevant changes or notifications while avoiding \
         repeated acquisition writes."
    ; search_terms =
        [ "watch workspace"; "idle worker"; "wait for work"; "catch up"; "notifications" ]
    ; capability = "observation"
    ; steps =
        [ "Choose the source: attention for a worker's filtered wakeups, changes for \
           complete commit metadata, or inbox for addressed notifications."
        ; "Read the first bounded capture and retain its exact cursor and filters; \
           inspect omissions and next-position metadata before treating coverage as \
           complete."
        ; "Continue the same capture without substituting workspace, query, history or \
           notification counters. An oversized next row requires a larger budget at the \
           unchanged position."
        ; "After inspecting current readiness or notifications, wait from the retained \
           source position using attention.wait, changes.wait or inbox.wait; a timeout \
           creates no acknowledgement or ownership."
        ; "The harness decides whether to act or park again. Acknowledge only selected \
           handled inbox entries explicitly and acquire work through the actual guarded \
           mutation."
        ]
    ; methods =
        [ "attention.read"
        ; "attention.wait"
        ; "changes.read"
        ; "changes.wait"
        ; "inbox.read"
        ; "inbox.wait"
        ; "inbox.ack"
        ; "ticket.readiness"
        ]
    ; reference = "references/attention.md"
    }
  ; { id = "import_history"
    ; title = "Import and retrieve visible conversation history"
    ; summary =
        "Convert selected visible transcript events, save exact bytes, and find them \
         later under a fixed history capture."
    ; use_when =
        "You have a conversation or tool transcript to import, search and retrieve \
         without loading the whole history."
    ; search_terms =
        [ "import conversation JSONL"
        ; "transcript adapter"
        ; "history import helper"
        ; "convert messages"
        ; "recover old conversation"
        ]
    ; capability = "context"
    ; steps =
        [ "Inspect the source format and select only user-visible messages and tool \
           results. Never invent missing messages, import private reasoning, or treat \
           recorded claims as verification."
        ; "Read references/history.md and the bundled scripts/history-adapter.py --help. \
           The optional scripts/transcript-converter.py supports selected Claude JSONL \
           records, not arbitrary role/content JSONL; inspect its --help and input \
           requirements before use. These are Python scripts in the skill folder, not \
           daemon API methods."
        ; "Create a session with session.create. Convert each event to a stable \
           client_id, exact payload bytes and deliberately selected searchable_text; \
           preserve source provenance. Append with session.append or the adapter, saving \
           exact retry identities. Only durable acknowledgements permit discarding \
           another copy."
        ; "Use history.search for selected text, retaining the returned history capture \
           and event reference. Follow bounded continuation metadata before assuming the \
           search was complete."
        ; "Use history.get and history.payload to retrieve the exact selected message or \
           tool bytes at that capture. Check offsets, omitted content and payload \
           hashes; planning workspace revisions are not history captures."
        ]
    ; methods =
        [ "session.create"
        ; "session.append"
        ; "history.search"
        ; "history.get"
        ; "history.payload"
        ]
    ; reference = "references/history.md"
    }
  ; { id = "backup_restore"
    ; title = "Export, verify and restore a workspace"
    ; summary =
        "Create an immutable portable backup and restore it into a fresh root with \
         explicit lifecycle checks."
    ; use_when =
        "A local workspace must be backed up, transferred or recovered through its \
         supported portable format."
    ; search_terms =
        [ "backup workspace"; "restore backup"; "portable snapshot"; "transfer data" ]
    ; capability = "administration"
    ; steps =
        [ "Read daemon.health and workspace.list; choose a fresh absolute export \
           destination outside managed roots with an existing parent."
        ; "Save workspace.export and retain the actual export job ID and captured heads; \
           writes may continue while that immutable capture materializes."
        ; "Poll export.get until a terminal status and use export.verify on the \
           published complete workspace export; admission is not proof of completed \
           publication."
        ; "Save workspace.restore for a fresh private root in a registry where the \
           exported workspace identity is absent. Preserve the old data while \
           verification and replay run."
        ; "Inspect the durable restore receipt, then explicitly workspace.open because \
           restore registers the new root closed. Read workspace.overview and exact \
           retained sources before new work."
        ; "For a direct portable-tree handoff instead, finish exports and \
           workspace.close before the harness copies or transfers it; maintain one \
           writer at a time and verify ancestry on register/open."
        ]
    ; methods =
        [ "daemon.health"
        ; "workspace.list"
        ; "workspace.export"
        ; "export.get"
        ; "export.verify"
        ; "workspace.restore"
        ; "workspace.open"
        ; "workspace.overview"
        ; "workspace.close"
        ]
    ; reference = "references/administration.md"
    }
  ]
;;

let by_name =
  List.fold methods ~init:String.Map.empty ~f:(fun by_name method_ ->
    if Map.mem by_name method_.Method.name
    then invalid_arg ("duplicate method discovery content: " ^ method_.name);
    Map.set by_name ~key:method_.name ~data:method_)
;;

let find_method name = Map.find by_name name
