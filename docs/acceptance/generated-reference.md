# Executable API reference generation

`tools/generate_api_reference.py` reads the actual executable catalog and produces
one XML-structured Markdown file per method, an index and a hash manifest. It does
not maintain separate request or response schemas. Regeneration refuses to overwrite
unmanaged files or manual edits. `--check` detects drift without changing files.

Repeated anonymous subschemas are represented once using local `$defs`/`$ref` in
the same schema block, following [JSON Schema's definition mechanism](https://json-schema.org/understanding-json-schema/structuring#defs).
All fields, constraints and descriptions remain present. Literal defaults, examples
and arbitrary JSON values are not rewritten. Schemas with existing reference or
identifier scopes remain unchanged so reference resolution cannot change silently.

Independent tests expand generated references and compare every request and result
against the executable's original schema. They also cover deterministic output,
literal JSON preservation, XML CDATA boundaries, unsafe/duplicate method names,
drift detection and preservation of unmanaged or manually edited files.

On the 233-method intermediate catalog checked on 2026-10-09, repeated definitions
reduced generated Markdown from 16,666,749 to 6,355,935 bytes. The largest resume
reference fell from 2,781,785 to 178,709 bytes. These are document bytes, not token
measurements. Complex methods still have substantial contracts: start with the
focused workflow guide and load only the method or section needed.

The repository's `@runtest` gate requires exact guide/catalog method coverage and
checks the generated bundle against its built executable. Native qualification
performs both checks using installed files and the installed executable. An
intermediate catalog pass does not establish completion of the final API or
qualification of a release artifact.
