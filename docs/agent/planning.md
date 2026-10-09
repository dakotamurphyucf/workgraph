# Planning, tickets, comments and handoffs

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

```xml
<workgraph_reference name="planning">
<planning_api>
<rules><![CDATA[
Every mutation uses M and returns the planning durable receipt. Below, "returns" means
its inner .result.data. Every query uses Q+P and returns the planning query envelope;
"data" means .result.data. Base record definitions are in cli-contract.md, common_contract.

New tickets are todo. Readiness requires active workspace/project/milestone/ticket scope,
status todo, no claim, no hold, and all nonwaived prerequisites done. Ready tickets sort
by priority (unspecified last), then creation order (including within a batch), then ID.
Parent and dependency graphs are separately acyclic. A parent cannot complete until every child is done, even
if a child is canceled. Related links are symmetric information, not dependencies.
Catalog entries archive rather than disappear; archived entries cannot be newly assigned.
Status categories never change. A custom status sets the category; category/claim changes
clear that custom selection. Project/milestone progress is derived; status is set explicitly.
]]></rules>
<method name="workspace.update" envelope="M"><![CDATA[
Required: expected_revision:dec.
Optional: name:text, description:text, instructions:text, summary:text, archived:bool.
Returns: WorkspaceSettings.
Uses settings.revision, initially "0", not the planning workspace_revision.
]]></method>
<method name="workspace.archive" envelope="M"><![CDATA[
Required: expected_revision:dec, archived:bool.
Optional: none.
Returns: WorkspaceSettings.
Uses settings.revision. false unarchives. Archive does not unregister or delete data.
]]></method>
<method name="workspace.get" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: {name:text,settings:WorkspaceSettings}.
]]></method>
<method name="workspace.overview" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P, actor_id:id, run_id:id.
Data: {name,settings,projects:dec,tickets:dec,ready:dec,counts_by_status:{status:dec,...},active_projects:Page<Project>,held_work:Page<TicketSummary>,blocked_work:Page<TicketSummary>,recent_changes:Page<ActivitySummary>,resources:Page<ResourceSummary>}.
Actor/run filters narrow held_work only. Use this for a basic overview, or coordinator.overview for allocation, liveness and review attention.
]]></method>
<method name="actor.put" envelope="M"><![CDATA[
Required: target_actor_id:id, expected_revision:dec, name:text, kind:"person"|"agent".
Optional: archived:bool=false.
Returns: Actor.
Creates at revision "0" or replaces at the observed revision. Replacement resets omitted archived to false; name must be nonempty, <=512 bytes.
]]></method>
<method name="label.put" envelope="M"><![CDATA[
Required: label_id:id, expected_revision:dec, name:text.
Optional: description:text="", archived:bool=false.
Returns: Label.
Whole-record replacement; omitted description/archived reset to defaults. Expected "0" creates.
]]></method>
<method name="status.put" envelope="M"><![CDATA[
Required: status_id:id, expected_revision:dec, name:text, category:status.
Optional: archived:bool=false.
Returns: Status.
Expected "0" creates; existing category is immutable.
]]></method>
<method name="actor.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P.
Data: Page<Actor>.
]]></method>
<method name="label.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P.
Data: Page<Label>.
]]></method>
<method name="status.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P.
Data: Page<Status>.
]]></method>
<method name="project.create" envelope="M"><![CDATA[
Required: title:text.
Optional: project_id:id (generated if absent), description:text="".
Returns: Project.
Starts revision "1", status todo, priority "0".
]]></method>
<method name="project.update" envelope="M"><![CDATA[
Required: project_id:id, expected_revision:dec.
Optional: title:text, description:text, status, priority:dec, summary:text, acceptance_criteria:text, archived:bool.
Returns: Project.
]]></method>
<method name="project.archive" envelope="M"><![CDATA[
Required: project_id:id, expected_revision:dec, archived:bool.
Optional: same patches as project.update.
Returns: Project.
Retains history; visible work cannot be left depending on hidden unfinished prerequisites.
]]></method>
<method name="project.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P.
Data: Page<Project>.
]]></method>
<method name="project.get" envelope="Q"><![CDATA[
Required: project_id:id.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: Project.
]]></method>
<method name="project.brief" envelope="Q"><![CDATA[
Required: project_id:id.
Optional: P.
Data: {project:Project,resources:Page<ResourceSummary>,communication:{threads:Page<Thread>,requests:Page<Request>},progress:ProgressCounts,ready_work:Page<TicketSummary>,in_progress_work:Page<TicketSummary>,blocked_work:Page<TicketSummary>,tickets:Page<Ticket>,milestones:Page<Milestone>}.
]]></method>
<method name="milestone.create" envelope="M"><![CDATA[
Required: project_id:id, title:text.
Optional: milestone_id:id (generated if absent), description:text="", target_date:text (YYYY-MM-DD).
Returns: Milestone.
Starts revision "1" and status todo; project must exist.
]]></method>
<method name="milestone.update" envelope="M"><![CDATA[
Required: milestone_id:id, expected_revision:dec.
Optional: title:text, description:text, status, archived:bool.
Returns: Milestone.
Use milestone.schedule to change the date.
]]></method>
<method name="milestone.archive" envelope="M"><![CDATA[
Required: milestone_id:id, expected_revision:dec, archived:bool.
Optional: title:text, description:text, status.
Returns: Milestone.
]]></method>
<method name="milestone.schedule" envelope="M"><![CDATA[
Required: milestone_id:id, expected_revision:dec, target_date:text|null.
Optional: none.
Returns: Milestone.
A real YYYY-MM-DD date schedules; null clears.
]]></method>
<method name="milestone.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P, project_id:id.
Data: Page<Milestone>.
]]></method>
<method name="milestone.get" envelope="Q"><![CDATA[
Required: milestone_id:id.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: {milestone:Milestone,progress:ProgressCounts}.
]]></method>
<method name="ticket.create" envelope="M"><![CDATA[
Required: title:text.
Optional: ticket_id:id (generated if absent), description:text="", project_id:id, parent_ticket_id:id, milestone_id:id.
Returns: Ticket.
Starts todo, revision "1". Parent/project/milestone references must agree; omit absent references rather than sending null here.
]]></method>
<method name="ticket.update" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec.
Optional: title:text, description:text, status.
Returns: {ticket_id:id,revision:dec}.
Requires no current claim, including title/description edits. To finish claimed work use ticket.complete. Direct done transitions still check holds, prerequisites, children and review requirements.
]]></method>
<method name="ticket.metadata" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec.
Optional: priority:dec (0..4), assignee_id:id|null, label_ids:[id], acceptance_criteria:text, status_id:id|null.
Returns: {revision:dec}.
null clears assignee/custom status; [] clears labels. Assignments require active catalogs but do not claim work. Setting a custom status requires no claim and checks completion if its category is done.
]]></method>
<method name="ticket.move" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, project_id:id|null, milestone_id:id|null, parent_ticket_id:id|null.
Optional: none.
Returns: {moved:dec}.
All three destination fields are required. Moves the descendant subtree to the destination project; descendants keep parent links and clear milestone assignments when the project changes. Cycles/scope conflicts reject.
]]></method>
<method name="ticket.archive" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, archived:bool.
Optional: none.
Returns: {archived:bool}.
Preserves history and prevents new ready-work allocation while archived.
]]></method>
<method name="ticket.hold" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, reason:text|null.
Optional: none.
Returns: {revision:dec}.
A nonempty reason pauses readiness and completion without changing status; null clears the hold.
]]></method>
<method name="dependency.add" envelope="M"><![CDATA[
Required: ticket_id:id, prerequisite_id:id.
Optional: none.
Returns: {ticket_id:id}.
The ticket waits for prerequisite_id. No expected_revision parameter. Cycles reject even through waived edges. Removing an edge also removes its waiver.
]]></method>
<method name="dependency.remove" envelope="M"><![CDATA[
Required: ticket_id:id, prerequisite_id:id.
Optional: none.
Returns: {ticket_id:id}.
The ticket waits for prerequisite_id. No expected_revision parameter. Cycles reject even through waived edges. Removing an edge also removes its waiver.
]]></method>
<method name="dependency.waive" envelope="M"><![CDATA[
Required: ticket_id:id, prerequisite_id:id, expected_revision:dec, reason:text|null.
Optional: none.
Returns: {revision:dec}.
The edge must exist. Nonempty reason waives its blocking effect; null revokes the waiver. expected_revision belongs to the dependent ticket.
]]></method>
<method name="related.add" envelope="M"><![CDATA[
Required: ticket_id:id, related_id:id, expected_revision:dec, related_expected_revision:dec.
Optional: none.
Returns: {ticket_revision:dec,related_revision:dec}.
Updates both endpoint revisions atomically. Links are symmetric; max100 per ticket; self-links reject. Cycles here are allowed and do not affect readiness.
]]></method>
<method name="related.remove" envelope="M"><![CDATA[
Required: ticket_id:id, related_id:id, expected_revision:dec, related_expected_revision:dec.
Optional: none.
Returns: {ticket_revision:dec,related_revision:dec}.
Updates both endpoint revisions atomically. Links are symmetric; max100 per ticket; self-links reject. Cycles here are allowed and do not affect readiness.
]]></method>
<method name="ticket.claim" envelope="M"><![CDATA[
Required: ticket_id:id.
Optional: expected_revision:dec, lease_duration_ms:dec (1..86400000).
Returns: {ticket_id:id,token:dec}.
Requires readiness and no owner; switches to in_progress and clears custom status. A supplied revision rejects intervening changes; omission atomically selects current eligible unclaimed work. Claims are indefinite unless a lease duration is supplied. Read ticket.context to inspect the resulting lease; ticket.renew_lease is cataloged in coordination.
]]></method>
<method name="ticket.start" envelope="M"><![CDATA[
Required: ticket_id:id.
Optional: expected_revision:dec, lease_duration_ms:dec (1..86400000), initial_note:text, attempt_id:id.
Returns: {ticket_id:id,token:dec,attempt?:{attempt_id:id,revision:dec,state:"running"}}.
Atomically claims eligible unclaimed work, writes the optional nonblank initial note and starts the optional fresh attempt. An attempt requires attributed run ownership. Revision guards, required paths, external conditions and ownership checks apply before publication. Omitted fields select defaults; explicit null rejects.
]]></method>
<method name="ticket.finish" envelope="M"><![CDATA[
Required: ticket_id:id, token:dec (positive), evidence:text (nonblank).
Optional: handoff:{summary:text,next_steps:text,objective:text?,completed:text?,decisions:text?,blockers:text?,resource_ids:[id]?,covers_through:dec?}.
Returns: {completed:true,ticket_revision:dec,attempt?:{attempt_id:id,revision:dec,state:"completed"}}.
Publishes the optional handoff, active attempt completion, evidence comment and ticket completion together. Requires current unexpired ownership and rechecks holds, prerequisites, unfinished children and configured acceptance policy. Blocked readiness returns the same typed blockers as ticket.start. ticket_revision is the affected ticket revision, independent of attempt/handoff and workspace revisions. Exact retries recover the original durable receipt.
Within finish, omitted rich handoff fields and covers_through preserve the prior values; explicit empty strings/lists clear them. A first handoff defaults omitted rich fields to empty and coverage to zero. Completion evidence becomes this new handoff's evidence. Summary and next_steps are required whenever handoff is supplied. This patch behavior differs from standalone handoff.set replacement defaults. Historical handoffs remain immutable.
]]></method>
<method name="ticket.reopen" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, reason:text (nonblank).
Optional: none.
Returns: {ticket_id:id,revision:dec}.
Reopens completed work as unclaimed todo with a fresh ownership fence. Prior evidence, attempts and waivers remain. Dependent claims/statuses remain, structured reassessments record the reopening, and running dependents receive durable notifications.
]]></method>
<method name="ticket.reassign" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, claimant_id:id|null, reason:text.
Optional: claimant_run_id:id|null.
Returns: {token:dec|null}.
Requires an existing claim and no active attempt (finish it first). Nonempty reason is recorded. New owner gets a fresh indefinite claim/token; null claimant releases to todo and requires no claimant_run_id. Prior tokens become stale.
]]></method>
<method name="ticket.release" envelope="M"><![CDATA[
Required: ticket_id:id, token:dec.
Optional: none.
Returns: {released:true,ticket_revision:dec}.
Actor and optional run must match claim. Use only your own current token; visible sequential tokens are stale-writer fences, not credentials. Clears it, sets todo, and cancels active attempts with evidence that the claim was released. Can release an expired claim using its matching identity.
]]></method>
<method name="ticket.complete" envelope="M"><![CDATA[
Required: ticket_id:id, token:dec, evidence:text.
Optional: none.
Returns: {completed:true,ticket_revision:dec}.
Requires a current unexpired claim, nonempty evidence, no hold, done/waived prerequisites, done children, and applicable evidence/review gates. Completes active attempts, clears claim, sets done and adds an evidence comment.
]]></method>
<method name="ticket.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P, text:text, project_id:id, milestone_id:id, status, assignee_id:id, label_id:id, priority:dec.
Data: Page<Ticket>.
text filters title/description case-insensitively. ticket.ready adds graph-readiness and priority ordering; it does not apply a registered run's allocation rules. Use ticket.claim_next for atomic run-aware selection.
]]></method>
<method name="ticket.ready" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P, text:text, project_id:id, milestone_id:id, status, assignee_id:id, label_id:id, priority:dec.
Data: Page<Ticket>.
text filters title/description case-insensitively. ticket.ready adds graph-readiness and priority ordering; it does not apply a registered run's allocation rules. Use ticket.claim_next for atomic run-aware selection.
]]></method>
<method name="ticket.resolve" envelope="Q"><![CDATA[
Required: display_key:text.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: {ticket_id:id,display_key:text}.
Use the returned ID in other methods, not the display key.
]]></method>
<method name="ticket.readiness" envelope="Q"><![CDATA[
Required: ticket_id:id.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: Readiness.
]]></method>
<method name="ticket.blockers" envelope="Q"><![CDATA[
Required: ticket_id:id.
Optional: limit:dec, offset:dec, at_revision:dec, max_bytes:dec (4096..1048576).
Data: Page<TicketSummary>.
Lists unfinished nonwaived prerequisites. Read readiness for holds, status and ownership reasons too.
]]></method>
<method name="ticket.context" envelope="Q"><![CDATA[
Required: ticket_id:id.
Optional: P.
Data: {ticket:Ticket,related:Page<TicketSummary>,resources:Page<ResourceSummary>,communication:{threads:Page<Thread>,requests:Page<Request>},attempts:Page<Attempt>,evidence:EvidenceContext,readiness:Readiness,parent:Ticket|null,children:Page<Ticket>,blocker_ticket_ids:[id],handoff:Handoff|null,updates:Page<Comment>,activity_since_handoff:Page<ActivitySummary>}.
Updates/activity follow handoff.covers_through, or revision0 when no handoff exists. Evidence has its own {data,meta} envelope with query_scope="evidence", query_revision and budget. Resource, communication and attempt schemas are in resources.md, communication-evidence.md and coordination.md.
]]></method>
<method name="comment.add" envelope="M"><![CDATA[
Required: body:text, target:Entity_ref.
Optional: comment_id:id (generated if absent), reply_to_id:id, kind:DiscussionKind="comment".
Returns: {comment_id:id,sequence:dec,revision:"1"}.
Comments can discuss another actor's claimed work; reply_to_id must have the same target. A comment tagged evidence/decision is still ordinary discussion, not a formal manifest or decision record.
]]></method>
<method name="comment.edit" envelope="M"><![CDATA[
Required: comment_id:id, expected_revision:dec, body:text.
Optional: none.
Returns: {comment_id:id,revision:dec}.
Only the original author can edit authored comments. Generated completion evidence (origin="completion") cannot be edited or tombstoned: append comment.add with kind="evidence" and reply_to_id set to the original comment ID. This correction does not reopen the ticket. Preserves older versions; changing a declared input creates reconciliation records in the same transaction.
]]></method>
<method name="comment.tombstone" envelope="M"><![CDATA[
Required: comment_id:id, expected_revision:dec.
Optional: none.
Returns: {comment_id:id,revision:dec}.
Only the original author can tombstone authored comments. Generated completion evidence is immutable. Marks the current version as a tombstone; prior versions remain in history. No body field.
]]></method>
<method name="comment.get" envelope="Q"><![CDATA[
Required: comment_id:id.
Optional: P.
Data: Comment with author_id, actor_id and nullable reply_to_comment_id.
]]></method>
<method name="comment.history" envelope="Q"><![CDATA[
Required: comment_id:id.
Optional: P.
Data: Page<Comment>.
Oldest-to-newest versions, including tombstones.
]]></method>
<method name="comment.list" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: P, target:Entity_ref, include_tombstones:bool=false.
Data: Page<Comment>.
Omitting target lists comments across the workspace. Explicit null and the old ticket_id selector reject.
]]></method>
<method name="ticket.progress" envelope="M"><![CDATA[
Required: ticket_id:id, token:dec, body:text.
Optional: kind:DiscussionKind="progress".
Returns: {comment_id:id,sequence:dec}.
Requires current actor/run claim and valid lease. Creates a discussion comment; does not increment the ticket entity revision.
]]></method>
<method name="handoff.set" envelope="M"><![CDATA[
Required: ticket_id:id, expected_revision:dec, summary:text, next_steps:text, evidence:text.
Optional: token:dec, objective:text="", completed:text="", decisions:text="", blockers:text="", resource_ids:[id]=[], covers_through:dec.
Returns: Handoff.
expected_revision is the HANDOFF revision ("0" initially). On claimed work token is required and must match actor/run; on unclaimed work omit token. Optional text/list fields replace prior values with their defaults when omitted. covers_through defaults conservatively to "0"; supply the last planning workspace_revision actually reviewed to assert a reviewed prefix. A handoff does not infer that unseen concurrent work was read.
]]></method>
<method name="handoff.get" envelope="Q"><![CDATA[
Required: ticket_id:id.
Optional: at_revision:dec, max_bytes:dec (4096..1048576).
Data: Handoff.
Not_found when no handoff exists.
]]></method>
<method name="handoff.history" envelope="Q"><![CDATA[
Required: ticket_id:id.
Optional: limit:dec, offset:dec, at_revision:dec, max_bytes:dec (4096..1048576).
Data: Page<Handoff>.
Oldest-to-newest complete handoffs. Historical prose and provenance stay exact; an oversized first row requires a larger max_bytes budget.
]]></method>
<method name="activity.since" envelope="Q"><![CDATA[
Required: none beyond envelope.
Optional: limit:dec, offset:dec, at_revision:dec, max_bytes:dec, after:dec="0", target:{kind:"project",project_id:id}|{kind:"milestone",milestone_id:id}|{kind:"ticket",ticket_id:id}|{kind:"resource",resource_id:id}|{kind:"workspace"} OR project_id:id, actor_id:id.
Data: Page<Activity>.
Returns revisions strictly greater than after in ascending order. Activity filters select affected entities, not transcript events. Each Activity uses actor_id and complete ordered changes with named kind objects covering facts, communication, runs, evidence, policy changed/unchanged, allocation empty, recovery, signal retry receipt, settings, workspace, project, milestone, ticket, comment, handoff and resource changes. Retained descriptions/bodies, frozen recipients, initial comment_revision pins, selected notification_ids, digests, counters and provenance remain exact. Byte fitting drops a page suffix only; an oversized first retained transaction requires a larger budget and never returns an unchanged success cursor. To expand a WG09 source, query after=(source.workspace_revision-1) with the current at_revision guard, then locate its exact revision and change ordinal. The guard selects the current capture, not an arbitrary historical snapshot.
]]></method>
<method name="search.query" envelope="Q"><![CDATA[
Required: text:text (nonblank, <=256 bytes).
Optional: P, project_id:id, target:{kind:"project",project_id:id}|{kind:"milestone",milestone_id:id}|{kind:"ticket",ticket_id:id}|{kind:"resource",resource_id:id}|{kind:"workspace"}, kinds:["workspace"|"project"|"milestone"|"ticket"|"comment"|"handoff"|"resource"|"resource_text"|"fact"].
Data: Page<SearchHit> plus unindexed_resources:Page, index_revision:dec, sources_scanned:dec, coverage:object.
Case-insensitive substring search over current revisions. kinds must be nonempty/distinct when supplied. SearchHit={source:{kind,revision,workspace_id|project_id|milestone_id|ticket_id|comment_id|resource_id (according to kind); fact uses exact scope and key},target:Entity_ref,matches:[{field,match_offset:dec,match_bytes:dec,snippet_offset:dec,snippet:text}]}; offsets count UTF-8 bytes. Text resources contribute at most64KiB each and1MiB per request. coverage records current_revisions_only, eligible/indexed/unindexed/truncated_text_resources, resource_prefix_bytes and request_text_bytes. unindexed_resources entries give source, reason (prefix_only/invalid_utf8/not_requested/query_text_budget/unsupported_mime), indexed_bytes, omitted_bytes, size_known. Narrow by target/project or read full resources; this is not full conversation-history search.
]]></method>
<method name="transaction.apply" envelope="M"><![CDATA[
Required: operations:[{method:text,params:object,as?:id}] (1..32).
Optional: none.
Returns: {results:[{method:"ticket.create",data:...},...]}, one complete
method-tagged receipt per input operation, in input order. Each data object uses
the same result schema as that method called directly. A template expansion has
one outer result containing its own explicitly tagged internal operations.
Inner params contain no M envelope. All operations share actor/run, one receipt and one workspace revision. Preconditions run in order; final graphs/references validate together. No nested batches, administration, history stream writes, upload staging or worker-only publication. Template expansion also counts toward32 operations. A creation can bind an as alias; use "$alias" only in typed ID positions, including supported nested references. Forward ID references resolve but do not bypass operations that need an entity to exist at execution time. Aliases are type-checked; ordinary text containing "$alias" stays literal.
]]></method>
<batch_aliases><![CDATA[
Creation alias kinds: project.create/project_id; milestone.create/milestone_id;
ticket.create/ticket_id; comment.add/comment_id; resource.put_text/resource_id at revision0;
board.put/board_id, thread.put/thread_id, team.put/team_id, subscription.put/subscription_id
at revision0; request.create/request_id; run.register/target_run_id; attempt.start/attempt_id;
contract.put/contract_id, manifest.publish/manifest_id, decision.put/decision_id at revision0; review.record/review_id;
validation.add/validation_id; template.instantiate or template.instance_register/instance_id.
Only the supported project/milestone/ticket/comment/resource creations generate omitted IDs.
Other creation IDs must be supplied. Do not add arbitrary as aliases to updates.
Example complete parameters for an atomic project and ticket creation:
{"workspace_id":"demo","actor_id":"agent","mutation_id":"plan-1","operations":[
 {"method":"project.create","as":"p","params":{"project_id":"p1","title":"Deliver feature"}},
 {"method":"ticket.create","params":{"ticket_id":"t1","project_id":"$p","title":"Implement feature"}}
]}
]]></batch_aliases>
<facts><![CDATA[
Facts store small shared JSON values under exact keys in one explicit scope. Use resources
for longer notes/logs. Scope is {kind:"workspace"} or {kind:"project"|"milestone"|"ticket",id}.
There is no inheritance: the same key in different scopes is independent. Keys are exact,
case-sensitive UTF-8 (1..128 bytes, nonblank, no controls). Values are arbitrary valid JSON,
at most4096 canonical bytes and16 container levels; null is a value, never deletion.
Records include scope,key,revision,deleted,actor_id,optional run_id,timestamp,
changed_at_revision and (when present) value,value_type. Deletion retains the key's history
and revision. Updates are cooperative shared writes guarded by the key revision, not claims.
Queries accept max_bytes (4096..1048576, default65536) and optional at_revision. List pages
accept limit(1..100, default50), offset(default0); offset>0 requires at_revision from the
previous result.meta.workspace_revision. Whole values are never clipped: budget omissions
reduce page items; increase max_bytes when no item fits. Mutation retry uses the exact same
mutation_id/params. A new update needs a new mutation_id and the observed fact revision.
Retained facts are bounded to10000 keys and16MiB of version metadata per workspace.
Readable exports group keys/history into one JSON file per scope, never one file per key.
]]></facts>
<method name="fact.put" envelope="M"><![CDATA[
Required: scope,key,expected_revision:dec,value:JSON. Returns: fact record.
Use expected_revision="0" for a never-used key. Recreating a deleted key uses its current
revision. Scope IDs may use batch aliases; JSON value content always remains literal.
]]></method>
<method name="fact.delete" envelope="M"><![CDATA[
Required: scope,key,expected_revision:dec. Returns: deleted fact record.
Missing keys reject; repeated deletion conflicts. History remains queryable.
]]></method>
<method name="fact.get" envelope="Q"><![CDATA[
Required: scope,key. Optional: at_revision,max_bytes. Returns: exact current fact record,
including a tombstone when deleted; missing key is Not_found. No pagination parameters.
]]></method>
<method name="fact.multi_get" envelope="Q"><![CDATA[
Required: scope,keys:[key] (up to100). Optional: limit,offset,at_revision,max_bytes.
Returns: {items,offset,remaining,next_offset}. Preserves requested order, including explicit
{scope,key,missing:true} for absent keys. Deleted records remain visible.
]]></method>
<method name="fact.list" envelope="Q"><![CDATA[
Required: scope. Optional: prefix:text,include_deleted:bool(defaultfalse),limit,offset,
at_revision,max_bytes. Returns: page of current fact records, sorted by exact key.
Prefix matching is case-sensitive; empty prefix matches all keys in this scope.
]]></method>
<method name="fact.keys" envelope="Q"><![CDATA[
Same parameters/order as fact.list. Returns: page of key metadata with revision/value_type
and attribution, excluding values. Use this first to discover useful stored context.
Ticket context also includes bounded fact_keys with total/remaining counts.
]]></method>
<method name="fact.history" envelope="Q"><![CDATA[
Required: scope,key. Optional: limit,offset,at_revision,max_bytes. Returns: oldest-first
page of all attributed versions, including deletions. Missing key is Not_found.
]]></method>
<method name="fact.search" envelope="Q"><![CDATA[
Required: scope,text (nonblank, up to256 bytes). Optional: limit,offset,at_revision,max_bytes.
Returns: page of matches in active keys/current JSON values, with byte offsets and bounded
snippets. ASCII case-insensitive substring matching. search.query also supports kind "fact".
]]></method>
</planning_api>
</workgraph_reference>
```
