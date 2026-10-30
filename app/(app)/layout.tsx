import Link from "next/link";
import { BarChart3, LogOut, Settings, ShoppingBag } from "lucide-react";
import { BottomNav, SideNav } from "@/components/nav";
import { signOut } from "@/app/actions";
import { isSupabaseConfigured, requireHousehold } from "@/lib/household";
import { cookies } from "next/headers";
import { ThemeQuickToggle } from "@/components/theme-toggle";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <NotConfigured />;

  const ctx = await requireHousehold();
  const { count } = await ctx.supabase
    .from("agent_tasks")
    .select("id", { count: "exact", head: true })
    .eq("household_id", ctx.household.id)
    .eq("status", "pending");
  const pending = count ?? 0;
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px]">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line/80 px-4 py-6 lg:flex">
        <Link href="/" className="flex items-center gap-3 px-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-ink"><ShoppingBag size={21} /></span>
          <div>
            <p className="text-sm font-semibold text-white">Resale HQ</p>
            <p className="max-w-[9rem] truncate text-xs text-slate-500">{ctx.household.name}</p>
          </div>
        </Link>
        <SideNav pendingCount={pending} />
        <div className="mt-auto flex items-center justify-between px-1">
          <span className="text-xs text-slate-500">Theme</span>
          <ThemeQuickToggle initial={theme} />
        </div>
        <form action={signOut} className="mt-2">
          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-slate-500 hover:bg-white/[0.04] hover:text-white">
            <LogOut size={16} /> Sign out
          </button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 pb-28 pt-4 sm:px-7 lg:px-10 lg:pb-10 lg:pt-8">
        <div className="mb-4 flex items-center justify-between lg:hidden">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-ink"><ShoppingBag size={17} /></span>
            <span className="text-sm font-semibold text-white">Resale HQ</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/insights" className="rounded-xl p-2 text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Insights"><BarChart3 size={19} /></Link>
            <ThemeQuickToggle initial={theme} />
            <Link href="/settings" className="rounded-xl p-2 text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Settings"><Settings size={19} /></Link>
          </div>
        </div>
        {children}
      </main>
      <BottomNav pendingCount={pending} />
    </div>
  );
}

function NotConfigured() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="surface max-w-lg p-7">
        <p className="eyebrow">Setup needed</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">Connect Supabase to start tracking</h1>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-300">
          <li>Copy <code className="text-accent">.env.example</code> to <code className="text-accent">.env.local</code> and add your Supabase URL and publishable key.</li>
          <li>Apply both files in <code className="text-accent">supabase/migrations</code>, in order, in the Supabase SQL editor.</li>
          <li>Restart <code className="text-accent">npm run dev</code>, then sign up at <code className="text-accent">/login</code>.</li>
        </ol>
        <p className="mt-4 text-xs text-slate-500">Full steps: docs/supabase-setup.md</p>
      </section>
    </main>
  );
}
