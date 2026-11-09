import type { ReactNode } from "react";
import { Icon, type IconName } from "../../../components/Icon";

/** Persistent native disclosures keep the reader's position during live updates. */
export function InspectorDisclosure({
  title,
  description,
  icon,
  tone = "blue",
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: IconName;
  readonly tone?: "blue" | "purple" | "green" | "gold" | "pink";
  readonly children: ReactNode;
}) {
  return (
    <details className="work-guide-section" data-tone={tone}>
      <summary>
        <span className="work-guide-icon">
          <Icon name={icon} />
        </span>
        <span>
          <strong>{title}</strong>
          <span className="work-guide-description">{description}</span>
        </span>
        <Icon name="chevron" />
      </summary>
      <div className="work-guide-body">{children}</div>
    </details>
  );
}
export function InspectorIntro({
  title,
  description,
  icon,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: IconName;
}) {
  return (
    <header className="work-tab-intro">
      <span className="work-guide-icon">
        <Icon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}
