import type { Path } from "./model";
/** Plain-language field help shared by view and renderer forms. */
export function fieldHelp(path: Path): string | undefined {
  const leaf = path.at(-1);
  if (path.length === 1)
    return {
      title: "A recognizable name in your library, such as Release tickets or Research files.",
      id: "A unique settings ID, not a ticket ID. Keep it stable when editing; use letters, digits, underscores or hyphens.",
      description: "Explain who this view is for and what it helps them find.",
      source:
        "Which kind of Workgraph record to read. Changing it may require updating existing columns and filters.",
      presentation:
        "Table compares columns; list shows cards; board groups ticket statuses; timeline organizes sessions by time.",
      filter_mode:
        "Server filters narrow the query before loading. Loaded filters examine only records already fetched, so more matches may remain on later pages.",
      group_by:
        "Place records with the same field value together. None keeps a single group. Ticket boards require status.",
    }[String(leaf)];
  if (path[0] === "scope")
    return leaf === "kind"
      ? "Workspace uses this source’s workspace scope. Resources and facts do not automatically include every project’s content. Other options select a project, milestone or ticket supported by the source."
      : "Choose the project, milestone or ticket to read. This does not move or change any records.";
  if (leaf === "pointer" || leaf === "rows")
    return "A path inside JSON: /summary reads the summary field; /items/0 reads the first item. Leave empty for the whole value. Use ~1 for a slash and ~0 for a tilde in a field name.";
  if (leaf === "selector")
    return "Field selects a known record property. Pointer reads a path inside structured JSON and may require additional content reads.";
  if (leaf === "field")
    return "The record property to display, compare or sort. Available properties depend on the selected source.";
  if (leaf === "direction")
    return "Ascending goes A–Z or smallest/oldest first; descending reverses that order. Missing values stay last.";
  if (leaf === "op")
    return "Equals matches an exact value; one of accepts any listed value; literal prefix matches the start; contains text finds a text fragment. Each source supports particular server filters.";
  if (leaf === "type" && path.includes("format"))
    return "How to display the saved value: text, number, readable size, timestamp, duration, link, JSON or a labeled category. This does not convert the stored data.";
  if (leaf === "unit")
    return "The unit already used by your data: nanoseconds, microseconds, milliseconds or seconds. Choose correctly so durations are displayed accurately.";
  if (leaf === "tone")
    return "The color for this category, paired with its label. Use consistent meaning, such as green for success and orange for attention.";
  if (leaf === "label")
    return "The name people see in the result. It can be friendlier than the underlying field name.";
  if (leaf === "id")
    return path[0] === "columns"
      ? "A unique name for this column within the view, such as ticket_title."
      : "The exact identifier declared by the data or referenced configuration.";
  if (leaf === "resource_id")
    return "The resource containing the published renderer configuration. This must reference a saved renderer, not an arbitrary file.";
  if (leaf === "digest")
    return "The SHA-256 fingerprint of that exact resource version. Copy it from the published resource; it prevents silently loading different content.";
  if (leaf === "size_bytes")
    return "The exact size of that saved resource version in bytes, used to verify its content.";
  if (leaf === "version")
    return "The exact recorded version to match or read. This is not a request for the latest version.";
  if (leaf === "entity")
    return "Which kind of value this display recipe applies to: a fact, resource content or history payload.";
  if (leaf === "key_prefix")
    return "Only match fact keys beginning with this text, such as build. or metrics/.";
  if (leaf === "root_type")
    return "The outermost JSON value: object for named fields, array for a list, or a scalar such as text or a number.";
  if (leaf === "language") return "Syntax highlighting only. Code is displayed, never executed.";
  if (leaf === "type" && path[0] === "presentation")
    return "Fields shows labeled values; table reads an array; Markdown, code and JSON display a selected part of the content.";
  return undefined;
}
