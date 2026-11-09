/** Readable display only: the exact recorded timestamp remains available on the
 * time element. An unparseable value is shown unchanged, never inferred. */
export function RecordedTime({
  value,
  compact = false,
}: {
  readonly value: string;
  readonly compact?: boolean;
}) {
  const normalized = value.replace(" ", "T").replace(/(\.\d{3})\d+(?=Z$)/u, "$1");
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? (
    <time dateTime={normalized} title={value}>
      {new Intl.DateTimeFormat(
        undefined,
        compact
          ? new Date(millis).toDateString() === new Date().toDateString()
            ? { hour: "numeric", minute: "2-digit" }
            : { month: "short", day: "numeric" }
          : { dateStyle: "medium", timeStyle: "short" },
      ).format(millis)}
    </time>
  ) : (
    <span title="Exact recorded timestamp">{value}</span>
  );
}
