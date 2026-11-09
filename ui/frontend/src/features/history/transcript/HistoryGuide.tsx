import { Icon } from "../../../components/Icon";
import type { Guide } from "./guides";
export function HistoryGuide({ title, icon, description, hint }: Guide) {
  return (
    <aside className="ht-guide">
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
        <p className="ht-guide-hint">{hint}</p>
      </div>
    </aside>
  );
}
