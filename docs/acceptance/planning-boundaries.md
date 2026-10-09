# Planning implementation boundaries

This records the initial State extraction and its validation checkpoint. Later
feature modules build on these boundaries; the test counts below do not qualify
all subsequent changes in the current checkout.

`State` remains the public abstract API for immutable committed snapshots and
unpublished prepared transactions. Its implementation delegates to six private
modules; this is an internal decomposition, not a change to transaction semantics.

| Module | Responsibility |
| --- | --- |
| `Planning_state` | Immutable snapshot representation, related entity types, shared graph/ownership/reference invariants and snapshot projections |
| `Planning_replay` | Resolved event application, independent transaction validation and audit reconstruction |
| `Planning_prepare` | Command/batch staging, resolved events, referenced blobs and final validation through replay |
| `Planning_search` | In-memory document selection and scoped resource-text coverage |
| `Planning_query` | Bounded reads and query routing over one immutable snapshot |
| `Planning_render` | Lazy human-readable export materialization, one file at a time |

All six are Dune-private modules. Their internal record representations are not
new public constructors or deserializers. The persistence owner still receives a
prepared candidate and publishes only after durable storage acknowledges it.
Neither preparation nor replay performs I/O. The independent history journal and
its commit boundary are unchanged.

The extraction preserved all 65 original top-level function bodies. Private
interfaces were drafted before moving implementations and expose only helpers
needed across these boundaries. Root review checked the moved bodies, invariants,
facade and dependency direction. An independent reviewer also compared the bodies
and verified that an external client can compile against `State` but cannot access
`Planning_state` through the installed library interface.

Existing expect tests, malformed replay fixtures, typed clients, real socket
workflows and the 66-case main daemon integration suite validate the unchanged
behavior. Formatter, build, test and install aliases are required after the move.
Future lifecycle and API changes should stay within these responsibilities rather
than rebuilding a monolithic State implementation.

During final validation, the socket feed test exposed a shutdown acknowledgement
race: the shutdown flag could cancel the requester before its response was written.
The service now attempts the bounded response write before initiating cancellation;
a disconnected requester still triggers shutdown. A controlled memory-transport gate
covers the acknowledgement race, invalid-parameter rejection and lost-peer case.
The final formatter/build/test/install invocation passed, including the real-socket
regression and all 66 main integration cases. Both reviewers inspected the fix and
confirmed that the admitted-work drain barrier remains ordered after cancellation.
