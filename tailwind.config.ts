import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: { colors: { ink: "#0b1020", panel: "#111a2e", line: "#24304a", accent: "#65a8ff" }, boxShadow: { glow: "0 18px 60px rgba(0,0,0,0.22)" } } },
  plugins: []
};
export default config;
