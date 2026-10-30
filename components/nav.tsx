"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, HandCoins, Home, MessageSquareText, PiggyBank, Plus, Settings } from "lucide-react";

// On-screen names are plain words; routes stay as they are.
const LINKS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/inventory", label: "Stuff", icon: Boxes },
  { href: "/offers", label: "Offers", icon: HandCoins },
  { href: "/money", label: "Money", icon: PiggyBank },
  { href: "/notes", label: "Notes", icon: MessageSquareText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/money") return path === href || path.startsWith("/insights");
  return path === href || path.startsWith(href + "/");
}

export function SideNav({ pendingCount }: { pendingCount: number }) {
  const path = usePathname();
  return (
    <nav className="mt-6 space-y-1">
      <Link href="/inventory/new" className="btn-primary mb-4 w-full"><Plus size={17} /> Add item</Link>
      {LINKS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={
            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium " +
            (isActive(path, href) ? "bg-accent/15 text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-white")
          }
        >
          <Icon size={17} />
          {label}
          {href === "/offers" && pendingCount > 0 && (
            <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent">{pendingCount}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/** Bottom tab bar for phones: Home, Stuff, big +, Offers, Money. Notes and Settings live in the top bar. */
export function BottomNav({ pendingCount }: { pendingCount: number }) {
  const path = usePathname();
  const pick = (href: string) => LINKS.find(l => l.href === href)!;
  const items = [pick("/"), pick("/inventory"), { href: "/inventory/new", label: "Add item", icon: Plus }, pick("/offers"), pick("/money")];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="Main">
      <div className="mx-auto grid max-w-md grid-cols-5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === "/inventory/new" ? path === href : isActive(path, href) && !(href === "/inventory" && path === "/inventory/new");
          return (
            <Link
              key={href}
              href={href}
              aria-label={href === "/inventory/new" ? label : undefined}
              aria-current={active ? "page" : undefined}
              className={"relative flex flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-medium " + (active ? "text-white" : "text-slate-400")}
            >
              {href === "/inventory/new" ? (
                <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-md ring-4 ring-panel"><Icon size={24} strokeWidth={2.5} /></span>
              ) : (
                <span className={"flex h-7 w-12 items-center justify-center rounded-full " + (active ? "bg-accent/20" : "")}><Icon size={20} /></span>
              )}
              {href !== "/inventory/new" && label}
              {href === "/offers" && pendingCount > 0 && (
                <span className="absolute right-[24%] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-panel" aria-label={`${pendingCount} waiting`}>{pendingCount}</span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
