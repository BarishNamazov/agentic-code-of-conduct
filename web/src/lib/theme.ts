import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "behaving-agents:theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  return {
    theme,
    setTheme: setThemeState,
    toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
  };
}

/**
 * Deterministic, theme-aware color/initial pair derived from a string id.
 * Used to give each agent a stable visual identity across views.
 */
export function identityFor(id: string): {
  hue: number;
  initials: string;
  color: string;
  bg: string;
  border: string;
} {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  // Pull initials from the human-friendly tail (after the last underscore)
  // so spawned `agent_<uuid>` ids still produce something readable.
  const tail = id.split(/[_-]/).filter(Boolean).pop() ?? id;
  const initials = tail.slice(0, 2).toUpperCase();
  return {
    hue,
    initials,
    color: `hsl(${hue} 70% 65%)`,
    bg: `hsl(${hue} 60% 55% / 0.14)`,
    border: `hsl(${hue} 60% 55% / 0.45)`,
  };
}
