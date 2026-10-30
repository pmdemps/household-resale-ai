import { Download, LogOut } from "lucide-react";
import { addMemberByEmail, setDisplayName, signOut } from "@/app/actions";
import { requireHousehold } from "@/lib/household";
import { PLATFORMS } from "@/lib/platforms";
import { cookies } from "next/headers";
import { ThemePicker } from "@/components/theme-toggle";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

const EXPORTS = [
  { type: "items", label: "Inventory" },
  { type: "listings", label: "Listings" },
  { type: "offers", label: "Offers" },
  { type: "sales", label: "Sales & profit" },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ member?: string; name?: string }> }) {
  const ctx = await requireHousehold();
  const { member, name } = await searchParams;
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const { data: members } = await ctx.supabase.from("household_members").select("user_id, role, display_name").eq("household_id", ctx.household.id);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Settings</h1>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Look</h2>
        <p className="mt-1 text-sm text-slate-400">Saved on this device only, so each of you can pick your own.</p>
        <div className="mt-3"><ThemePicker initial={theme} /></div>
      </section>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Your name</h2>
        <p className="mt-1 text-sm text-slate-400">Shown on your notes and activity.</p>
        <form action={setDisplayName} className="mt-3 flex flex-wrap gap-2">
          <input name="display_name" maxLength={40} className="field min-w-[12rem] flex-1" placeholder="First name"
            defaultValue={(members ?? []).find(m => m.user_id === ctx.userId)?.display_name ?? ""} />
          <button className="btn-primary">Save</button>
        </form>
        {name === "saved" && <p className="mt-2 text-sm text-good">Saved.</p>}
      </section>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Household</h2>
        <p className="mt-1 text-sm text-slate-400">{ctx.household.name} · {members?.length ?? 1} member{members?.length === 1 ? "" : "s"} · you are {ctx.role}</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {(members ?? []).map((m, i) => (
            <li key={m.user_id} className="rounded-full border border-line px-3 py-1 text-xs text-slate-300">
              {m.display_name || (m.user_id === ctx.userId ? "You" : `Member ${i + 1}`)}{m.user_id === ctx.userId ? " (you)" : ""} · {m.role}
            </li>
          ))}
        </ul>
        {ctx.role === "admin" && (
          <form action={addMemberByEmail} className="mt-4 flex flex-wrap gap-2">
            <input name="email" type="email" required className="field min-w-[14rem] flex-1" placeholder="Their account email" />
            <button className="btn-primary">Add member</button>
          </form>
        )}
        {member === "added" && <p className="mt-2 text-sm text-good">Added. They&apos;ll see this household next time they sign in.</p>}
        {member === "not_found" && <p className="mt-2 text-sm text-warn">No account with that email yet. Ask them to sign up at /login first, then add them.</p>}
      </section>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Export</h2>
        <p className="mt-1 text-sm text-slate-400">CSV files open in Excel, Numbers, or Google Sheets.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXPORTS.map(e => (
            <a key={e.type} href={`/api/export?type=${e.type}`} className="btn-secondary"><Download size={15} /> {e.label}</a>
          ))}
        </div>
      </section>

      <form action={signOut} className="lg:hidden">
        <button className="btn-secondary w-full"><LogOut size={15} /> Sign out</button>
      </form>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Marketplaces</h2>
        <ul className="mt-3 divide-y divide-line">
          {PLATFORMS.filter(p => p.id !== "other").map(p => (
            <li key={p.id} className="py-3">
              <p className="text-sm text-white">
                {p.name}
                {p.hasAccount && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-link">account set up</span>}
                <span className="ml-2 text-[11px] text-slate-500">{p.integration === "official_api" ? "API available" : p.integration === "email_only" ? "email tracking" : "manual"}</span>
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-400">{p.integrationNote}</p>
              {p.postingRules.length > 0 && <ul className="mt-1 list-disc pl-4 text-xs leading-5 text-slate-300">{p.postingRules.map(r => <li key={r}>{r}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
