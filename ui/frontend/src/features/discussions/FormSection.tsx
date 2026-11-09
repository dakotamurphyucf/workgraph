import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";
/** Flat form sections separate decisions without nesting containers. Optional
 * settings use sibling disclosures; mutation ownership stays in the controller. */
export function FormSection({
  title,
  description,
  icon = "settings",
  tone = "blue",
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon?: IconName;
  readonly tone?: "blue" | "violet" | "green" | "amber";
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="dc-form-section" data-tone={tone} aria-labelledby={id}>
      <header>
        <span className="dc-form-section-icon">
          <Icon name={icon} />
        </span>
        <div>
          <h3 id={id}>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <div className="dc-form-section-fields">{children}</div>
    </section>
  );
}
