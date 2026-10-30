import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resale HQ | Household Resale AI",
  description: "A smarter home base for resale inventory, sourcing, listings, and profit.",
  appleWebApp: { capable: true, title: "Resale HQ", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#141416" },
    { media: "(prefers-color-scheme: light)", color: "#fff8e7" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme === "system" ? undefined : theme} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
