import { useEffect, useState } from "react";
export type ThemePreference = "system" | "dark" | "light";
const key = "workgraph.ui.theme";
export function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(key);
    return value === "dark" || value === "light" ? value : "system";
  } catch (error: unknown) {
    if (error instanceof DOMException) return "system";
    throw error;
  }
}
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preference === "system" ? (media.matches ? "dark" : "light") : preference;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem(key, preference);
    } catch (error: unknown) {
      if (!(error instanceof DOMException)) throw error;
    }
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [preference]);
  return { preference, setPreference };
}
