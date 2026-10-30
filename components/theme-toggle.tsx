"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_COOKIE, type ThemeChoice } from "@/lib/theme";

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  // Per device: each person's phone keeps its own look.
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

function useTheme(initial: ThemeChoice) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);
  useEffect(() => setChoice(initial), [initial]);
  return [choice, (c: ThemeChoice) => { setChoice(c); apply(c); }] as const;
}

/** Three-way picker for Settings. */
export function ThemePicker({ initial }: { initial: ThemeChoice }) {
  const [choice, set] = useTheme(initial);
  const opts: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
    { id: "light", label: "Sunflower", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "system", label: "Match device", icon: Monitor },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
      {opts.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={choice === id}
          onClick={() => set(id)}
          className={"flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-sm " +
            (choice === id ? "border-accent bg-accent/10 text-white" : "border-line text-slate-400 hover:text-white")}
        >
          <Icon size={18} />
          {label}
        </button>
      ))}
    </div>
  );
}

/** One-tap sun/moon switch for the header. */
export function ThemeQuickToggle({ initial }: { initial: ThemeChoice }) {
  const [choice, set] = useTheme(initial);
  const [systemLight, setSystemLight] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    setSystemLight(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemLight(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const isLight = choice === "light" || (choice === "system" && systemLight);
  return (
    <button
      type="button"
      onClick={() => set(isLight ? "dark" : "light")}
      className="rounded-xl p-2 text-slate-400 hover:bg-white/[0.06] hover:text-white"
      aria-label={isLight ? "Switch to dark mode" : "Switch to sunflower mode"}
      title={isLight ? "Dark mode" : "Sunflower mode"}
    >
      {isLight ? <Moon size={19} /> : <Sun size={19} />}
    </button>
  );
}
