# Read and compare resource content

Open a resource in **Resources**. Its content header identifies the selected
content version, SHA-256 digest, size and type. The companion retrieves that exact
publication; the browser verifies the complete file before making its verified
download available. A later metadata refresh or publication does not replace an
already selected version. A missing historical version or a digest mismatch is
an error, never a request to show current content instead.

The **Viewer** selector changes presentation without changing the stored bytes.
Automatic presentation uses the captured filename/type. Markdown supports passive
tables, lists and fenced code; bundled highlighting covers OCaml, TypeScript,
JavaScript, JSON, shell, Python, Markdown, YAML, TOML, HTML, CSS and diff. The
**Language override**, **Source** and **Raw bytes** controls remain available.
HTML and SVG are never executed, and Markdown image references do not fetch
remote images. Downloads preserve exact bytes rather than a rendered or
reformatted copy.

## JSON

The lossless JSON view preserves numeric spellings, including integers beyond
JavaScript's exact integer range, decimal trailing zeros and negative zero.
Strings remain strings; missing fields and null stay distinct. Object names such
as `__proto__` are ordinary data. Duplicate decoded names, invalid UTF-8, invalid
Unicode and malformed JSON are rejected with the source retained.

Two levels are initially expanded. Use the labeled disclosure buttons and
**Previous/Next JSON rows** controls to inspect more. At most 2000 expanded rows
are mounted at once. Long labels/scalars are visibly abbreviated; Source and the
verified download remain authoritative. A path beyond 16 tokens or 512 UTF-8
bytes is unavailable for further disclosure, rather than evaluated as a property
expression. JSON previews accept up to 4MiB, depth 64 and 100000 values/field
names, with a bounded aggregate decoded-string size.

## Raster images

PNG, JPEG, WebP and GIF use a passive canvas preview. The viewer checks the file's
signature, declared MIME, dimensions and frame rectangles before decoding, then
checks the decoded oriented dimensions. Its limits are 8MiB encoded, 8192 pixels
per edge and 16 million pixels. Compressed data must also pass the browser's image
decoder. SVG, HTML and other image formats retain source/download access.

**Fit** preserves aspect ratio inside the available viewport. **Actual pixels**
uses one image pixel per CSS pixel. The zoom buttons support manual 10–800% zoom;
Fit can use a smaller scale for a large image. Focus the image viewport and use
`+`/`−`, `0` for actual pixels, `F` for Fit and arrow keys to pan. Dimensions are
reported after EXIF orientation. A neutral checkerboard makes transparency
visible.

Animated GIF/WebP files display only a static default image or first-frame poster,
with an animation label. There is no playback or automatic motion. The preview
owns and closes its graphics resources when the capture changes or the pane is
closed. GIF is a service mark of CompuServe Incorporated.

## Compare immutable versions

Expand **Compare immutable content versions**, enter the exact right content
version and select **Load exact comparison**. The left publication remains
pinned. The right version is resolved at a captured planning revision and its
complete file is independently verified. Both endpoints/generations, content
versions, digests and sizes are shown, with separate verified downloads.

Choose the comparison presentation explicitly when useful:

- **Text lines** shows added, removed and unchanged lines. Its bounds are 256KiB
  and 10000 lines per side, and one million comparison cells.
- **JSON values** preserves missing/null distinctions, array order and exact
  number lexemes. `1` and `1.0` count as lexical changes. An object field-order or
  whitespace-only difference can be labeled as formatting only. A comparison
  above 2000 changed paths retains both exact sources instead of a partial result
  that looks complete.
- **Images** provides independently decoded static posters side by side or in an
  opacity-controlled overlay at their actual relative pixel sizes.
- **Binary identity** compares verified SHA-256 and size without inventing text.

**Pinned sources side by side** provides bounded Source/Raw access even when a
rich comparison exceeds its budget. A comparison is read-only; viewing an old
version does not restore it or create a publication.

## When a preview is unavailable

Malformed, unsupported and over-budget content have different messages. A worker
failure or deadline is also separate: it does not mean a healthy file is malformed.
CPU phases use a two-second processing budget, and an active preview has a
ten-second worker deadline. Waiting for capacity does not consume that deadline. The lossless parser runs synchronously inside its bounded worker phase;
an overrun is checked after return and a main-side watchdog can terminate it.
Selection changes cancel obsolete viewer work. Visible blocks wait automatically
for capacity; offscreen blocks defer work. There are two active workers, room for
24 admitted jobs and 128 cancellable capacity waiters. The 32MiB admitted-byte
ceiling avoids multiplying large source copies across every block. Parser failures
still require an explicit retry; waiting does not repeat a daemon write.

Rich and highlighted previews allow 2MiB, 100,000 lines, 250,000 combined content
and syntax nodes, and 96 nesting levels. These higher limits accommodate substantial
JSON captures. Node count includes syntax tokens, not just JSON fields. The limits
bound the resulting React/DOM tree as well as worker output: a local Chrome check
of 5,000 structured records (802,782 bytes) produced 90,002 syntax spans and took
about one second to display, with a longest observed frame around 433ms. This is
local design evidence, not a cross-platform performance guarantee. Larger captures
retain source windows and byte downloads; normal queue contention is not an error.

These are viewer limits, not daemon content limits. Complete verified resource
files up to 64MiB remain downloadable through [Resources](resources.md), including
larger text and binary files. A bounded preview prefix is labeled partial. Never
use that prefix as if it were a complete file or an immutable evidence pin.
