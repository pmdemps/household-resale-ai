import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Resale HQ | Household Resale AI",
  description: "A smarter home base for resale inventory, sourcing, listings, and profit.",
  appleWebApp: { capable: true, title: "Resale HQ", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#0b1020", width: "device-width", initialScale: 1, viewportFit: "cover" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
