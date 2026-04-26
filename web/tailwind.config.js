import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build a tailwind palette where each shade resolves to a CSS variable.
// We use the `<alpha-value>` placeholder so utilities like `bg-neutral-900/40`
// continue to work, while the actual color is theme-driven from `index.css`.
function tokenPalette(name) {
  const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const out = {};
  for (const s of shades) {
    out[s] = `rgb(var(--${name}-${s}) / <alpha-value>)`;
  }
  return out;
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
        display: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        // Theme-aware palettes: shades stay the same in both modes, but each
        // shade resolves to a different RGB channel value depending on theme.
        neutral: tokenPalette("neutral"),
        emerald: tokenPalette("emerald"),
        red: tokenPalette("red"),
        yellow: tokenPalette("yellow"),
        sky: tokenPalette("sky"),
        violet: tokenPalette("violet"),
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          soft: "rgb(var(--accent-soft) / <alpha-value>)",
          strong: "rgb(var(--accent-strong) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          sunken: "rgb(var(--surface-sunken) / <alpha-value>)",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--accent) / 0.35), 0 0 24px -4px rgb(var(--accent) / 0.45)",
        soft: "0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px -8px rgb(var(--shadow) / 0.5)",
        card: "0 1px 0 rgb(var(--neutral-50) / 0.02) inset, 0 8px 32px -16px rgb(var(--shadow) / 0.6)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(circle at 50% 0%, rgb(var(--accent) / 0.10), transparent 60%)",
      },
    },
  },
  plugins: [],
};
