import { Icon } from "./Icon";

/** Stable local identity marker, never a claim that a process is online. */
export function ActorAvatar({
  actor,
  unavailable = false,
}: {
  readonly actor: string | null;
  readonly unavailable?: boolean;
}) {
  const words = actor?.split(/[-_\s]+/u).filter(Boolean) ?? [];
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase()
      : (actor?.slice(0, 2).toUpperCase() ?? "");
  let color = 0;
  for (const c of actor ?? "") color = (color * 31 + c.charCodeAt(0)) >>> 0;
  const label = actor ?? (unavailable ? "Assignment not loaded" : "Unassigned");
  return (
    <span
      className={`wg-actor-avatar wg-actor-avatar--${actor === null ? "empty" : color % 4}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {actor === null ? <Icon name="participants" /> : initials}
    </span>
  );
}
