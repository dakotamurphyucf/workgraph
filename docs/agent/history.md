# Sessions and retained conversation history

Read [the shared CLI and wire contract](cli-contract.md) before constructing requests.
Return to [the capability guide](../../AGENT_GUIDE.md) to choose another reference.
Unless a result is explicitly shown as a complete envelope, it describes `result.data`;
receipt, query and capture metadata are in `result.meta`. These are the current preview
contracts, not compatibility guarantees for previously published previews.

```xml
<workgraph_reference name="history">
<section id="history-sessions" title="Sessions and complete retained conversation history">
  <contract>
    These methods record supplied observations; the harness owns provider calls, payload conversion, searchable-text selection, context assembly and eviction. Recording a session does not publish a team discussion or guarantee provider replay. Session mutations commit a separate history journal, not a planning workspace revision. Referencing a committed event from a later planning mutation is a second commit, with no cross-stream atomicity. Preserve source IDs and await durable:true before evicting the only copy of an observation.
    Mutation envelope M is workspace_id, actor_id, mutation_id, with optional run_id. Query envelope Q is workspace_id only. Omit absent optional method arguments unless a nullable value is explicitly documented. All IDs are strings; counters, sequences, offsets, byte lengths and limits are canonical nonnegative decimal strings. Session IDs are 1..96 ASCII letters/digits/underscore/hyphen. Unknown or duplicate fields reject. Results described below are .result.data. Durable acknowledgements are in .result.meta.durable; immutable capture metadata is in .result.meta.history_capture. History results have no planning workspace revision or budget diagnostics object.
  </contract>
  <schema name="Entity_ref"><![CDATA[
{"kind":"workspace"}
{"kind":"project","id":"project-id"}
{"kind":"milestone","id":"milestone-id"}
{"kind":"ticket","id":"ticket-id"}
{"kind":"resource","id":"resource-id"}
]]></schema>
  <schema name="Event_ref"><![CDATA[{"session_id":"conversation","sequence":"1"}]]></schema>
  <schema name="Blob_ref"><![CDATA[{"digest":"64 lowercase hexadecimal SHA-256 characters","size_bytes":"byte count 0..67108864"}]]></schema>
  <schema name="Content" description="Tagged object alternatives; kind selects the exact required fields."><![CDATA[
{"kind":"inline","bytes_base64":"standard Base64 of opaque bytes"}
{"kind":"blob","blob":{"digest":"64 lowercase hexadecimal SHA-256 characters","size_bytes":"byte count"}}
]]></schema>
  <schema name="Session_event_input" description="client_id, role, kind, phase and payload are required. Optional correlation and searchable_text accept explicit null. Optional provenance defaults to null; resource_versions and attachments default to []."><![CDATA[
{"client_id":"stable-source-event-id","role":"user","kind":"message","phase":"completed",
 "correlation":null,"provenance":null,
 "payload":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="},
 "searchable_text":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="},
 "resource_versions":[],"attachments":[]}
]]></schema>
  <schema name="Session_event_input_rules">
    client_id, role, kind and phase are arbitrary nonempty valid UTF-8 strings, each 1..256 bytes; they are not validated enum arrays. Conventionally use role=user/assistant/tool, kind=message/tool_call/tool_result, and phase=completed. Explicit partial lifecycle observations are allowed; Workgraph does not infer provider lifecycle. correlation is null or a UTF-8 string of at most 256 bytes. provenance is any JSON value whose canonical JSON is at most 4096 bytes and whose container nesting depth is at most 32. payload is required Content; opaque payload bytes may be invalid UTF-8. searchable_text is null or Content containing complete valid UTF-8 text, never a prefix silently represented as complete. attachments is an array of at most 100 Blob_ref objects; each referenced blob must already be installed in this workspace. resource_versions is an optional array of at most 100 objects {resource_id,revision}, where revision is a content version string in 1..100000, not the resource metadata revision; referenced versions must exist. Each inline Content is at most 16MiB; sum of inline payload and searchable text over one append is at most 16MiB. Blob Content and attachments are at most 64MiB each. Resolved scope/resource/session references never accept planning transaction aliases; opaque provenance/payload values remain literal. The protocol's 4MiB request frame can bind earlier than these library ceilings: stage larger content as resources using uploads, then reference installed blobs.
  </schema>
  <schema name="Session_record"><![CDATA[
{"workspace_id":"demo","session_id":"conversation","title":"Conversation","actor_id":"harness",
 "run_id":null,"parent_event":null,"scopes":[{"kind":"ticket","id":"task"}],"archived":false}
]]></schema>
  <schema name="Committed_event" description="The event input is nested in event; committed payload/text Content uses blob objects rather than inline bytes."><![CDATA[
{"event_ref":{"session_id":"conversation","sequence":"1"},"identity_hash":"64 lowercase hexadecimal SHA-256 characters",
 "actor_id":"harness","run_id":null,
 "event":{"client_id":"source-1","role":"user","kind":"message","phase":"completed",
          "correlation":null,"provenance":null,
          "payload":{"kind":"blob","blob":{"digest":"64 lowercase hexadecimal SHA-256 characters","size_bytes":"17"}},
          "searchable_text":null,"resource_versions":[],"attachments":[]}}
]]></schema>
  <schema name="History_capture"><![CDATA[
{"workspace_id":"demo","head":"immutable history journal SHA-256 or null",
 "sequence":"journal commit count","sessions":[{"session_id":"conversation","through":"last event sequence"}]}
]]></schema>
  <capture_rules>
    Query head omitted means capture current history. head as a 64-character lowercase digest selects that retained immutable journal head. Explicit head:null selects the empty history capture, not current history. Reuse returned meta.history_capture.head across session-list/read/search pages and payload expansion; later appends cannot invalidate or enter that capture. The capture contains the complete session/head vector, which itself can exceed a small budget. History query max_bytes defaults to "65536", range "4096".."1048576"; results fit this byte budget or return Blocked, rather than using planning query text/array truncation. Query limit is "1".."100". History queue admission is bounded to eight active/queued queries; Conflict means retry after another query finishes. First release retains every acknowledged event; capacity exhaustion rejects new work with Blocked and deletes nothing. History journal is bounded to 1000000 commits, 4MiB per encoded batch and 64MiB retained encoded batch metadata. Bytes referenced by events are durable before acknowledgement. Crash recovery excludes orphan/unpublished tails and verifies referenced blobs; uncertain publication fences the owner until recovery. Exact actor-scoped mutation retries recover the original durable {data,meta} response; changing method/arguments/run attribution under that key conflicts.
  </capture_rules>
  <method name="session.create" envelope="M">
    <arguments>Required session_id, title (nonempty 1..512 UTF-8 bytes). Optional parent_event=Event_ref of an already committed local event, scopes=[] array of at most 100 unique existing Entity_ref objects. Omit parent_event when absent; parent_event:null is not accepted as an optional create argument. actor and optional run in the stored session come from M. Session ID is explicit and is not generated.</arguments>
    <result><![CDATA[{"session":"Session_record object","through":"0"}]]></result>
    <behavior>A new session has no events; a fork stores a parent event reference, without copying its ancestor events into this session. New mutation with an existing session ID returns Conflict. Retry the original mutation after an uncertain response.</behavior>
    <example><![CDATA[{"workspace_id":"demo","actor_id":"harness","mutation_id":"create-session","session_id":"conversation","title":"Conversation","scopes":[{"kind":"ticket","id":"task"}]}]]></example>
  </method>
  <method name="session.archive" envelope="M">
    <arguments>Required session_id.</arguments>
    <result><![CDATA[{"session":"Session_record with archived:true"}]]></result>
    <behavior>Retains all history and references; future append rejects with Conflict. There is no unarchive method. Direct get/read/search and include_archived session-list remain available.</behavior>
    <example><![CDATA[{"workspace_id":"demo","actor_id":"harness","mutation_id":"archive-session","session_id":"conversation"}]]></example>
  </method>
  <method name="session.append" envelope="M">
    <arguments>Required session_id and events array of 1..128 Session_event_input objects. See complete input schema above.</arguments>
    <result><![CDATA[{"session_id":"conversation","through":"last committed event sequence","events":[{"session_id":"conversation","sequence":"1"}]}]]></result>
    <behavior>Assigns consecutive server event sequences starting at one, preserves input order for new events, and returns one event reference per input, including repeated existing source IDs. Same client_id and identical event content in a session deduplicates even with a new mutation ID; changed content returns Idempotency_conflict. Identity includes role/kind/phase/correlation/provenance/resource references/attachments and exact payload/text byte identity; an inline body and identical installed blob have the same identity. The stored actor/run attribution remains that of the original committed event. One append publishes its whole new batch or none. Archive prohibits new appends. through is a session event sequence, distinct from meta.history_capture.sequence (history journal commit count) and planning workspace_revision.</behavior>
    <example><![CDATA[{"workspace_id":"demo","actor_id":"harness","mutation_id":"append-source-1","session_id":"conversation","events":[{"client_id":"source-1","role":"user","kind":"message","phase":"completed","correlation":null,"provenance":{"adapter":"example"},"payload":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="},"searchable_text":{"kind":"inline","bytes_base64":"UmVxdWlyZW1lbnQ6IEJMVUU="},"resource_versions":[],"attachments":[]}]}]]></example>
  </method>
  <method name="session.get" envelope="Q">
    <arguments>Required session_id. Optional head, max_bytes.</arguments>
    <result><![CDATA[{"session":"Session_record object","through":"last event sequence in capture"}]]></result>
    <behavior>Not_found if the session is absent from the selected capture. Archived sessions are returned.</behavior>
    <example><![CDATA[{"workspace_id":"demo","session_id":"conversation","max_bytes":"65536"}]]></example>
  </method>
  <method name="session.list" envelope="Q">
    <arguments>Optional head, max_bytes, offset="0", limit="50", include_archived=false (JSON Boolean).</arguments>
    <result><![CDATA[{"items":["Session_record objects"],"next_offset":"offset plus returned item count","has_more":false}]]></result>
    <behavior>Ordered by session ID; excludes archived sessions by default. For the next page use next_offset with the same meta.history_capture.head and filters. Offset may be positive without a head, but then each call takes a new capture, so use head for stable pagination. Byte fitting may return fewer than limit. Capture/item that cannot fit returns Blocked.</behavior>
    <example><![CDATA[{"workspace_id":"demo","offset":"0","limit":"50","include_archived":true}]]></example>
  </method>
  <method name="history.get" envelope="Q">
    <arguments>Required event_ref=Event_ref. Optional head, max_bytes.</arguments>
    <result>One Committed_event object directly in data; the selected capture is in meta.history_capture. Use a previously returned head to pin the lookup.</result>
    <behavior>Not_found for a missing session or event outside this capture. Payload bytes require history.payload.</behavior>
    <example><![CDATA[{"workspace_id":"demo","event_ref":{"session_id":"conversation","sequence":"1"}}]]></example>
  </method>
  <method name="history.read" envelope="Q">
    <arguments>Required session_id and direction="before"|"after"|"around" (plain string). Optional anchor="0", limit="50", head, max_bytes. Anchor must be between zero and the selected session upper bound, inclusive.</arguments>
    <result><![CDATA[{"session_id":"conversation","through":"upper event bound","items":["Committed_event objects"],"has_more":false,"next_anchor":"last returned event sequence, or supplied anchor if empty","omitted_for_budget":"count omitted from the selected limited page"}]]></result>
    <behavior>after excludes anchor and returns increasing sequences; continue after next_anchor with the same head. before excludes anchor and returns decreasing sequences; continue before next_anchor. around starts at max(1,anchor-floor(limit/2)) and returns up to limit events in increasing order. To continue beyond an around page, use direction=after with next_anchor; repeatedly applying around recenters and can overlap. For an empty session anchor=0 is valid. Budget fitting may shorten a page; has_more means more candidates remain, not incomplete index coverage. omitted_for_budget counts only the remaining selected page candidates. An oversized capture/event returns Blocked.</behavior>
    <example><![CDATA[{"workspace_id":"demo","session_id":"conversation","direction":"around","anchor":"1","limit":"10","max_bytes":"65536"}]]></example>
  </method>
  <method name="history.search" envelope="Q">
    <arguments>Required text (nonempty valid UTF-8, at most 256 bytes). Optional session_id (otherwise all captured sessions), kinds=array of exact event kind strings, after_event=Event_ref, limit="50", max_bytes, head. Omit absent filters; null is not equivalent to omission.</arguments>
    <result><![CDATA[{"items":[{"event_ref":{"session_id":"conversation","sequence":"1"},"kind":"message","role":"user","byte_offset":"0","snippet":"Requirement: BLUE"}],"next":null,"restart_after_indexing":false,"has_more":false,"coverage":[{"session_id":"conversation","committed_through":"1","indexed_through":"1"}],"complete":true,"unindexed_events":"0","unsearchable_events":"0","omitted_for_budget":"0"}]]></result>
    <behavior>Searches the complete adapter-supplied searchable text blob with case-insensitive substring matching (ASCII lowercase transformation, not Unicode case folding), one hit per event at its first matching byte offset. Snippets are UTF-8-safe prefixes of at most 512 bytes. Ordering is session ID then sequence, not wall-clock order across sessions. after_event is exclusive in this ordering, must exist in the capture, and next is the last scanned reference, which may be a nonmatching event; use next, not the last hit. Continue only when has_more=true with unchanged head/text/session/kinds. coverage lists every captured session, even with a session filter; unsearchable/unindexed counts apply to the filtered set. complete=true means filtered events have been indexed, not that every opaque payload is searchable or that pagination is exhausted. No searchable_text contributes to unsearchable_events. If complete=false/restart_after_indexing=true, next=null: restart from the beginning after indexing; an empty partial result proves no absence. The daemon rebuilds/updates its derived disk index before each search; there is no separate public history-index wait method. Source journal/blobs remain authoritative. Expand a hit using history.read and history.payload with meta.history_capture.head.</behavior>
    <example><![CDATA[{"workspace_id":"demo","session_id":"conversation","text":"Requirement","kinds":["message","tool_result"],"limit":"10","max_bytes":"65536"}]]></example>
  </method>
  <method name="history.payload" envelope="Q">
    <arguments>Required event_ref=Event_ref. Optional part={kind:"payload"}|{kind:"searchable_text"}|{kind:"attachment",index:"0"} (default payload; attachment index is zero-based in 0..99), offset="0", length="32768" (0..262144), max_bytes, head. Offset is a byte offset in 0..total_bytes.</arguments>
    <result><![CDATA[{"blob":{"digest":"64 lowercase hexadecimal SHA-256 characters","size_bytes":"total byte count"},"offset":"requested offset","bytes_base64":"Base64 chunk","next_offset":"offset plus returned byte count","total_bytes":"complete blob byte count","has_more":false}]]></result>
    <behavior>Retrieves exact opaque payload, searchable UTF-8 text, or attachment bytes from the immutable capture. Missing searchable text or attachment returns Not_found. Actual chunk length is the largest prefix up to the requested length and remaining bytes that fits the complete data/meta response; an oversized capture or insufficient space for one requested byte returns Blocked; follow next_offset while has_more=true. next_offset is always a decimal string, including EOF, unlike resource.read_chunk's nullable EOF cursor. Zero length is accepted and may produce has_more=true without advancing; request a positive length for retrieval loops. Verify assembled bytes against blob.digest/size_bytes when materializing a complete file. Metadata alone never substitutes for preserved bytes.</behavior>
    <example><![CDATA[{"workspace_id":"demo","event_ref":{"session_id":"conversation","sequence":"1"},"part":{"kind":"payload"},"offset":"0","length":"4096","max_bytes":"65536"}]]></example>
  </method>
</section>
</workgraph_reference>
```
