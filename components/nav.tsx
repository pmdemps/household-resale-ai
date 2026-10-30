"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, HandCoins, LayoutDashboard, Plus, Settings } from "lucide-react";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/offers", label: "Offers", icon: HandCoins },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function SideNav({ pendingCount }: { pendingCount: number }) {
  const path = usePathname();
  return (
    <nav className="mt-8 space-y-1">
      {LINKS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={
            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm " +
            (isActive(path, href) ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-white")
          }
        >
          <Icon size={17} />
          {label}
          {href === "/offers" && pendingCount > 0 && (
            <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-ink">{pendingCount}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/** Bottom tab bar for phones. */
export function BottomNav({ pendingCount }: { pendingCount: number }) {
  const path = usePathname();
  const items = [LINKS[0], LINKS[1], { href: "/inventory/new", label: "Add", icon: Plus }, LINKS[2], LINKS[3]];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-md grid-cols-5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === "/inventory/new" ? path === href : isActive(path, href) && !(href === "/inventory" && path === "/inventory/new");
          return (
            <Link key={href} href={href} className={"relative flex flex-col items-center gap-1 py-2.5 text-[11px] " + (active ? "text-accent" : "text-slate-400")}>
              {href === "/inventory/new" ? (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-ink"><Icon size={18} /></span>
              ) : (
                <Icon size={19} />
              )}
              {href !== "/inventory/new" && label}
              {href === "/offers" && pendingCount > 0 && (
                <span className="absolute right-[22%] top-1.5 h-2 w-2 rounded-full bg-amber-400" aria-label={`${pendingCount} pending`} />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
