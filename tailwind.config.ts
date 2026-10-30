import type { Config } from "tailwindcss";

// Every color is a CSS variable (RGB channels) so one class works in both themes.
// Values live in app/globals.css under the dark (default) and light themes.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // "white" = strongest foreground: white in dark mode, near-black in light mode.
        white: v("fg"),
        ink: v("ink"),
        panel: v("panel"),
        line: v("line"),
        accent: v("accent"),
        // Text that sits on the gold accent: dark in both themes.
        "on-accent": v("on-accent"),
        // The accent as text or icon color: deep honey in light mode, gold in dark.
        link: v("link"),
        good: v("good"),
        bad: v("bad"),
        warn: v("warn"),
        pop: v("pop"),
        slate: {
          100: v("fg-100"),
          200: v("fg-200"),
          300: v("fg-300"),
          400: v("fg-400"),
          500: v("fg-500"),
          600: v("fg-600"),
        },
      },
      boxShadow: { glow: "0 18px 60px rgba(0,0,0,0.22)" },
    },
  },
  plugins: [],
};
export default config;
