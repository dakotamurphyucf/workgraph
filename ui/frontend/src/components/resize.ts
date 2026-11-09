export interface PaneLimits {
  readonly minimum: number;
  readonly maximum: number;
}
export function clampWidth(width: number, limits: PaneLimits): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(limits.minimum) ||
    !Number.isFinite(limits.maximum) ||
    limits.minimum <= 0 ||
    limits.maximum < limits.minimum
  )
    throw new Error("Invalid resizable pane dimensions.");
  return Math.max(limits.minimum, Math.min(limits.maximum, Math.round(width)));
}
export function keyboardWidth(
  width: number,
  key: string,
  side: "start" | "end",
  limits: PaneLimits,
): number | null {
  const current = clampWidth(width, limits);
  if (key === "Home") return limits.minimum;
  if (key === "End") return limits.maximum;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const change = (key === "ArrowRight" ? 16 : -16) * (side === "start" ? 1 : -1);
  return clampWidth(current + change, limits);
}
