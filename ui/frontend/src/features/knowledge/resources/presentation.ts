export function resourceSize(value: string | null): string {
  if (value === null) return "Size not recorded";
  const bytes = BigInt(value);
  for (const [unit, divisor] of [
    ["MiB", 1048576n],
    ["KiB", 1024n],
  ] as const) {
    if (bytes >= divisor)
      return `${bytes / divisor}.${((bytes % divisor) * 10n) / divisor} ${unit}`;
  }
  return `${bytes} bytes`;
}
export function resourceKind(mime: string): string {
  if (mime === "text/markdown") return "Markdown";
  if (mime.includes("json")) return "JSON";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("text/")) return "Text";
  return "File";
}
