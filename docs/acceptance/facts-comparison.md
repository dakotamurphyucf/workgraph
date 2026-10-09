# Small facts and resource comparison

A bounded real-daemon exercise on macOS ARM64 on 2026-10-09 stored the same 16
small JSON settings as ticket-scoped facts and as 16 separate text resources.
Each value contained a component name, a retry count and a Boolean. Reads checked
every recovered value against the original; key discovery checked that values
were absent. An actual export verified grouping on disk.

| Read operation | Calls | Request method/params bytes | Response JSON bytes |
| --- | ---: | ---: | ---: |
| `fact.multi_get`, all 16 known keys | 1 | 319 | 4,633 |
| `fact.keys`, discovery only | 1 | 97 | 3,601 |
| `resource.read`, all 16 known IDs | 16 | 1,376 | 4,360 |

Byte counts use compact UTF-8 JSON. Request counts include the method and params,
but exclude JSON-RPC IDs/version and socket framing. Response counts include the
JSON-RPC response, excluding framing. These are bytes, not tokens. Fact records
carry attribution and revision metadata, so batching reduced calls without
necessarily reducing response bytes.

The human-readable export contained one `facts/ticket-settings.json` file for all
16 facts. The equivalent resource representation produced 16 metadata Markdown
files and 16 content files under `resources/`. These counts exclude the common
export inventory and portable replay data.

This is one synthetic comparison against storing each small value as a separate
resource. It does not compare against manually grouping values in a resource, or
measure model usage, productivity, latency or broad performance. It used a built
executable with the current facts/resource contracts, not a qualified release
artifact. The fixture stopped its daemon and removed its temporary workspace.
