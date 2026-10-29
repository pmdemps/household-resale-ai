import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Resale HQ | Household Resale AI",
  description: "A smarter home base for resale inventory, sourcing, listings, and profit."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
