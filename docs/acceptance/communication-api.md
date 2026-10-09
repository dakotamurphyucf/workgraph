# Communication executable API qualification

The current public communication catalog covers boards, teams, subscriptions,
threads, formal requests, direct messages and consumer inboxes. Comment add/edit/
tombstone and get/list/history are also described by executable codecs. The same
request/result declarations validate transport and runtime boundaries. Public
records use named ID fields, lowercase enum strings and exact tagged objects;
private discussion snapshots and durable communication events retain separate
encodings.

Twenty-five communication descriptors and three comment query descriptors were
added in this slice. The command field declarations also produce raw transaction
reference codecs using explicit literal-or-alias values. Resolved domain commands
reject unresolved aliases; opaque titles, correlation values and bodies retain
literal text. Canonical request reply references resolve by request entity kind.

On 2026-10-08 the pinned toolchain completed:

```sh
./dev build lib/workgraph.cma @test/coordination/runtest @test/communication/runtest @test/direct_reads/runtest
```

The command exited zero. The communication and direct-read daemon/socket suites
passed in 1.119s and 1.216s. The native tests validate all 28 added request contracts,
unknown fields, malformed tags/nulls/aliases, encoders, public/durable separation,
page cursor consistency, explicit raw references and typed alias resolution.
Existing tests retain independent malformed replay and generated replay coverage.

The real communication fixture exercises every board/team/subscription/thread/
request method, comment queries, frozen team delivery membership, separate request
acknowledgement/responsibility/terminal transitions, changed communication and
paired discussion capture rejection, tombstone provenance, a 40KB body under a
4KiB response budget, current request source bodies versus immutable initial
message delivery bodies, selected consumer acknowledgements, and exact original
request receipt recovery after daemon restart and changed team membership.
Direct-read integration independently checks related captures and restart.

The capability guide checker passed. A fresh executable catalog contained 181
method descriptors versus 232 documented methods; 54 documented methods still
lacked descriptors, while ticket.start/finish/reopen descriptors lacked guide
method nodes. This slice does not claim whole-catalog completion. The root final
formatting, installation and complete test gate remains required.
