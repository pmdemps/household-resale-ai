export const THEME_COOKIE = "resale-theme";
export type ThemeChoice = "light" | "dark" | "system";
export const parseTheme = (v: string | undefined): ThemeChoice => (v === "light" || v === "dark" ? v : "system");
