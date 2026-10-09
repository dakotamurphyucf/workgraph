# Paths, external conditions and ownership recovery

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.

```xml
<workgraph_reference name="path_conditions_recovery">
<contract><![CDATA[
M means workspace_id, actor_id, mutation_id and optional run_id. Q means workspace_id.
Add the exact method fields below. IDs use 1..96 ASCII letters/digits/_/-; revisions,
tokens, epochs, sequence positions and milliseconds are canonical decimal strings.
Successes use result.data and result.meta; durable mutation receipt metadata records
workspace_revision and durable:true. Unknown/duplicate fields reject.

Paths identify cooperative logical worktree namespaces. They do not inspect physical
files or prevent writes. Use an explicit worktree_id shared by every cooperating
caller; run.worktree_ref remains free-form metadata. Callers must canonicalize symlink,
hardlink and case-folding aliases to one lexical identity. No daemon enforcement or
filesystem alias detection is implied. A canceled/expired run need not have stopped.
]]></contract>
<schemas>
<schema name="path_target"><![CDATA[
Target: {"worktree_id":"checkout-1","kind":"file"|"subtree","path":"src/main.ml"}.
Paths are relative valid UTF-8, nonempty and at most4096 bytes. Repeated slashes and
'.' components normalize. Reject absolute paths, '..' components, controls, backslashes
and glob metacharacters * ? [ ]. Worktree root '.' is allowed only for subtree.
Targets compare case-sensitively. A subtree overlaps its descendants at component
boundaries, so src overlaps src/main.ml but not src-other/main.ml. Distinct worktrees
never overlap. Durable replay rejects noncanonical targets rather than normalizing them.

Path reservation: {"target":TARGET,"epoch":"N","holders":[HOLDER,...]}.
Holder: {"run_id":"run","actor_id":"actor","token":"N","mode":"exclusive"|"shared","lease":LEASE}.
LEASE is the public lease object described in coordination.md. Holders of different
runs may overlap only when both modes are shared. Expiry never releases a holder:
incompatible holders, including expired holders, keep blocking until release/recovery.
Acquisition advances the target's epoch. Release retains that epoch and other holders.
]]></schema>
<schema name="ticket_path_policy"><![CDATA[
{"ticket_id":"task","revision":"1","declarations":[{"target":TARGET,"mode":"exclusive"}],"require_reservations":true}.
At most100 distinct targets. Requests normalize paths and sort declarations by target;
each target appears once. require_reservations defaults false. Declared paths remain
visible even when optional. Required paths gate readiness and atomically acquire missing
compatible ownership with claim/start/claim_next. Missing invocation run yields a blocker.
Live compatible covering holds are reused; fresh automatic holds are indefinite.
Existing shared holds are never upgraded implicitly, and expired holds are never released
implicitly. Renew timed ownership explicitly or confirm the old process is stopped/isolated
before guarded recovery. A failed grant leaves every proposed claim/attempt/path unchanged.
]]></schema>
<schema name="external_condition"><![CDATA[
Declaration: {condition_id,revision,ticket_id,operation_id,artifact,required,label,creator,
creator_run:null|id,recipients:[actor-id,...]}. creator and ticket_id are immutable.
artifact and signal evidence use the actual tagged pin objects in communication-evidence.md;
for example {"kind":"checksum","source":"deployment","digest":"64-lowercase-hex"}.
Returned recipients are distinct and sorted. Label is nonblank UTF-8, at most4096 bytes.
Condition record: {declaration:DECLARATION,satisfied:boolean,latest_signal:null|SIGNAL}.

Signal: {signal_id,condition_id,condition_revision,operation_id,artifact,evidence:[PIN,...],
summary,actor_id,run_id:null|id,timestamp,sequence}. At least one evidence pin, at most100;
summary is nonblank UTF-8, at most64KiB. The supplied signal must match the exact current
condition revision, operation and artifact. It is an attributed cooperative report, not
an authenticated external event. Workgraph never polls or executes an external service.
Every declaration replacement invalidates satisfaction until a signal binds its new
revision. Required pending conditions gate readiness/start. Replacing a running ticket's
condition is visible context; it does not stop the worker. Historical declarations/signals
and evidence pins remain available and are validated against their referenced versions.
The declaration creator and current ticket owner receive deduplicated durable notifications;
extra recipients can be declared. Actual routing is frozen on the transition.
]]></schema>
<schema name="ownership_recovery"><![CDATA[
Recovery request: {recovery_id,target,expected_epoch,old_run_id,old_actor_id,token,
expected_lease_revision,confirmation:"stopped"|"isolated",reason,evidence?:[PIN,...]}.
Named target is {"kind":"named","reservation_id":"name"}; path target is
{"kind":"path","target":TARGET}. All guard counters are positive. Evidence is optional,
at most100 validated pins. Reason is nonblank UTF-8 at most64KiB.
Recovery audit: {request:REQUEST,actor_id,run_id:null|id,timestamp,sequence}.
The exact old actor/run/token, reservation epoch and lease revision must still match.
A replacement owner/renewal invalidates the stale guard. Recovery can release expired or
live ownership after an explicit external stopped/isolated assertion. The daemon neither
kills processes nor proves isolation. Stable recovery IDs identify immutable audits;
exact mutation retries return the original receipt. Use ticket.recover's separate lifecycle
contract for ticket claims; these methods concern named/path reservations only.
]]></schema>
<schema name="coordination_page"><![CDATA[
CP: optional limit (default50, 1..100), max_bytes (default65536, 4096..1048576), offset
(default0), expected_revision. Result data: {items:[RECORD,...],next_offset:"N"|null,omitted:"N"}.
Metadata includes query_scope:"runs",query_revision:"N". Nonzero offset requires the
first page's query_revision as expected_revision. Without a supplied observation clock, pure readiness callers report observation_time_required for timed required ownership; runtime reads use the captured server clock. Lists preserve whole records and fail
Invalid_argument if one cannot fit; increase max_bytes. Keep filters unchanged. Path and
ticket lists use target/ticket order; condition/recovery lists use IDs. Signals use sequence
then signal ID. Record gets accept max_bytes with the same bounds/default and never clip.
]]></schema>
</schemas>
<methods>
<method name="reservation.paths.acquire" mode="M"><![CDATA[
Required: target_run_id, requests (1..32 distinct targets). Each request is
{target:TARGET,mode:"exclusive"|"shared",lease_duration_ms?:"1".."86400000"}.
Omit duration for indefinite ownership. Run must be active and actor-owned. All grants
stage atomically in target order, checking existing and earlier staged overlaps. Returns
{revision}; get each reservation for its exact token/lease.
]]></method>
<method name="reservation.path.renew" mode="M"><![CDATA[
Required: target_run_id,target,token,expected_lease_revision. Renews an unexpired timed
hold, preserving token/mode and advancing lease revision. Returns {revision}.
]]></method>
<method name="reservation.path.release" mode="M"><![CDATA[
Required: target_run_id,target,token. Exact actor/run/fence release, also permitted after
expiry or terminal run. Returns {revision}.
]]></method>
<method name="reservation.path.get" mode="Q"><![CDATA[Required: target; optional max_bytes. Returns complete Path reservation.]]></method>
<method name="reservation.path.list" mode="Q"><![CDATA[Optional CP. Returns page of Path reservations, including released empty holders.]]></method>
<method name="ticket.paths.put" mode="M"><![CDATA[
Required: ticket_id,expected_revision,declarations; optional require_reservations (false).
expected_revision is0 for creation; later edits require the current policy revision.
Returns {revision}, the coordination projection revision. Fetch ticket.paths.get for the
policy revision. An existing run may continue after a declaration edit; context exposes it.
]]></method>
<method name="ticket.paths.get" mode="Q"><![CDATA[Required: ticket_id; optional max_bytes. Returns complete Ticket path policy.]]></method>
<method name="ticket.paths.list" mode="Q"><![CDATA[Optional CP. Returns page of Ticket path policies.]]></method>
<method name="condition.put" mode="M"><![CDATA[
Required: condition_id,expected_revision,ticket_id,operation_id,artifact,label.
Optional required (true), recipients (at most100 actor IDs). Create with expected_revision0;
edit with exact current declaration revision. Ticket/creator stay immutable. Returns
{revision,condition:DECLARATION}; revision is the coordination projection revision.
]]></method>
<method name="condition.signal" mode="M"><![CDATA[
Required: signal_id,condition_id,expected_revision,operation_id,artifact,evidence,summary.
Exact current binding required. Returns {revision,signal:SIGNAL}. Repeating the stable
signal under a fresh mutation returns its original signal/time/sequence without a new
signal event only when all content and actor/run attribution are identical. Other reuse
fails Conflict. A new mutation receipt may have a later workspace revision. Exact mutation
retry remains authoritative for the original committed response.
]]></method>
<method name="condition.get" mode="Q"><![CDATA[Required: condition_id; optional max_bytes. Returns complete Condition record.]]></method>
<method name="condition.list" mode="Q"><![CDATA[Optional CP and ticket_id filter. Returns page of current Condition records.]]></method>
<method name="condition.signals" mode="Q"><![CDATA[Required: condition_id; optional CP. Returns page of immutable Signal records.]]></method>
<method name="reservation.recover" mode="M"><![CDATA[
Accepts exact Recovery request fields with target.kind:"named". Returns {revision,recovery:AUDIT}.
]]></method>
<method name="reservation.path.recover" mode="M"><![CDATA[
Accepts exact Recovery request fields with target.kind:"path". Returns {revision,recovery:AUDIT}.
]]></method>
<method name="recovery.get" mode="Q"><![CDATA[Required: recovery_id; optional max_bytes. Returns complete immutable Recovery audit.]]></method>
<method name="recovery.list" mode="Q"><![CDATA[Optional CP. Returns page of immutable Recovery audits.]]></method>
<method name="ticket.recover" mode="M"><![CDATA[
Required: recovery_id,ticket_id,expected_revision,old_actor_id,old_run_id (ID or null),
token,expected_lease_revision,confirmation (stopped|isolated),reason; optional evidence.
The exact prior ticket revision, claim actor/run/token and lease revision must match.
The atomic audit transition cancels only matching active attempts, clears the claim,
and preserves status, progress, previous evidence and terminal attempts. No process is
terminated. Returns {ticket_id,revision}. Reused recovery IDs fail Conflict; exact saved
mutation retries return the original receipt. Stale guards never release replacement work.
]]></method>
<method name="ticket.recovery.get" mode="Q"><![CDATA[
Required: recovery_id; optional max_bytes (4096..1048576). Returns the immutable ticket
recovery audit {request,actor_id,run_id:null|id,timestamp,sequence}. Metadata carries workspace_revision.
]]></method>
<method name="ticket.recovery.list" mode="Q"><![CDATA[
Optional ticket_id,limit,max_bytes,offset,expected_revision. Returns an audit page in
recovery ID order; metadata carries workspace_revision. Unlike the path audit list,
nonzero offsets require that exact workspace_revision as expected_revision. All records are complete.
]]></method>
</methods>
<example><![CDATA[
"$WG" call "$SOCKET" ticket.paths.put '{"workspace_id":"demo","actor_id":"worker","mutation_id":"paths-1","ticket_id":"task","expected_revision":"0","require_reservations":true,"declarations":[{"target":{"worktree_id":"checkout-1","kind":"subtree","path":"src"},"mode":"exclusive"}]}'
"$WG" call "$SOCKET" reservation.path.get '{"workspace_id":"demo","target":{"worktree_id":"checkout-1","kind":"subtree","path":"src"}}'
Save each exact mutation request before sending when uncertain outcomes need recovery.
A path declared on a ticket need not have a reservation until that ticket is claimed/started.
]]></example>
</workgraph_reference>
```
