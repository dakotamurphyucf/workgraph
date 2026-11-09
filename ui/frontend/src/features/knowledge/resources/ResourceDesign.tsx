import type { ReactNode } from "react";
import { Icon, type IconName } from "../../../components/Icon";

/** Resource forms separate the decision, its inputs and its effect. */
export function ResourceSection({
  title,
  description,
  icon = "resources",
  children,
  tone = "blue",
}: {
  readonly title: string;
  readonly description: string;
  readonly icon?: IconName;
  readonly children: ReactNode;
  readonly tone?: "blue" | "green" | "purple" | "orange";
}) {
  return (
    <section className="rs-form-section" data-tone={tone}>
      <header>
        <span className="rs-section-icon">
          <Icon name={icon} />
        </span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <div className="rs-section-body">{children}</div>
    </section>
  );
}
