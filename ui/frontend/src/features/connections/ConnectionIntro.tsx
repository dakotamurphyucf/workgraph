import { Icon, type IconName } from "../../components/Icon";

/** Presentation only; connection selection and durable lifecycle stay in their controllers. */
export function ConnectionIntro({
  section,
}: {
  readonly section: "profiles" | "profile" | "daemon" | "launches" | "administration";
}) {
  const sections: Record<
    typeof section,
    { readonly title: string; readonly icon: IconName; readonly description: string }
  > = {
    profiles: {
      title: "Your daemon connections",
      icon: "connection",
      description:
        "Connect to an existing Workgraph service or set up a local one. Each daemon can hold several workspaces; switch connections here, then choose a workspace in the sidebar.",
    },
    profile: {
      title: "Give your connection a home",
      icon: "connection",
      description:
        "A profile is a saved name and address. It helps this UI find a daemon, but contains none of your tickets or workspace data.",
    },
    daemon: {
      title: "Connect, check and manage",
      icon: "settings",
      description:
        "Inspect the selected address, start a local daemon when needed, or review a shutdown. Connection checks and selection are separate from starting or stopping the service.",
    },
    launches: {
      title: "Pick up an earlier startup",
      icon: "history",
      description:
        "Review saved plans and their last observed outcome. Reopen a plan to inspect it or recover the same attempt without losing its original paths and identity.",
    },
    administration: {
      title: "Tools for files and recovery",
      icon: "advanced",
      description:
        "Work with local migration and recovery files on the companion’s machine. These tools remain available when no daemon is connected. Review the source, destination and effect before applying a change.",
    },
  };
  const content = sections[section];
  return (
    <div className="cm-intro">
      <span>
        <Icon name={content.icon} />
      </span>
      <div>
        <h3>{content.title}</h3>
        <p>{content.description}</p>
      </div>
    </div>
  );
}
