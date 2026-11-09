import { Icon } from "../../components/Icon";
import { ActorAvatar } from "../../components/ActorAvatar";
import type { ViewGuide } from "./guides";
export function ParticipantGuide({
  icon,
  title,
  description,
  example,
}: ViewGuide & { readonly title: string }) {
  return (
    <aside className="pt-guide">
      <span className="pt-guide-icon">
        <Icon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        <p className="pt-guide-example">{example}</p>
      </div>
    </aside>
  );
}
export function WriterContext({
  actor,
  workspace,
  run,
}: {
  readonly actor: string;
  readonly workspace: string;
  readonly run: string | null;
}) {
  return (
    <div className="pt-writer-context">
      <ActorAvatar actor={actor} />
      <div>
        <strong>Acting as {actor}</strong>
        <span>
          Workspace {workspace}
          {run ? ` · Run ${run}` : " · No writer run selected"}
        </span>
      </div>
      <span className="pt-tag">Draft keeps this identity</span>
    </div>
  );
}
