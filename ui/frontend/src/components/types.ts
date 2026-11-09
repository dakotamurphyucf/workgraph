import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Select an acting identity before invoking this new action; other disabled guards remain authoritative. */
  readonly requiresActor?: boolean;
  readonly tone?: "default" | "primary" | "quiet" | "danger";
}
export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly children: ReactNode;
}
export interface DialogProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly wide?: boolean;
}
export interface StatePanelProps {
  readonly kind: "loading" | "empty" | "error" | "offline" | "unavailable" | "partial";
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}
export interface ResizablePaneProps {
  readonly id: string;
  readonly label: string;
  readonly side: "start" | "end";
  readonly initialWidth: number;
  readonly onEscape?: () => void;
  readonly minimum: number;
  readonly maximum: number;
  readonly children: ReactNode;
  readonly className?: string;
}
export interface InspectorProps {
  readonly initialWidth?: number;
  readonly maximumWidth?: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}
