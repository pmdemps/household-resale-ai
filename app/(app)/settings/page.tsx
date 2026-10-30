import { Download } from "lucide-react";
import { addMemberByEmail } from "@/app/actions";
import { requireHousehold } from "@/lib/household";
import { PLATFORMS } from "@/lib/platforms";

const EXPORTS = [
  { type: "items", label: "Inventory" },
  { type: "listings", label: "Listings" },
  { type: "offers", label: "Offers" },
  { type: "sales", label: "Sales & profit" },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ member?: string }> }) {
  const ctx = await requireHousehold();
  const { member } = await searchParams;
  const { data: members } = await ctx.supabase.from("household_members").select("user_id, role").eq("household_id", ctx.household.id);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Settings</h1>

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Household</h2>
        <p className="mt-1 text-sm text-slate-400">{ctx.household.name} · {members?.length ?? 1} member{members?.length === 1 ? "" : "s"} · you are {ctx.role}</p>
        {ctx.role === "admin" && (
          <form action={addMemberByEmail} className="mt-4 flex flex-wrap gap-2">
            <input name="email" type="email" required className="field min-w-[14rem] flex-1" placeholder="Their account email" />
            <button className="btn-primary">Add member</button>
          </form>
        )}
        {member === "added" && <p className="mt-2 text-sm text-emerald-300">Added. They&apos;ll see this household next time they sign in.</p>}
        {member === "not_found" && <p className="mt-2 text-sm text-amber-200">No account with that email yet. Ask them to sign up at /login first, then add them.</p>}
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

      <section className="surface p-5">
        <h2 className="text-base font-semibold text-white">Marketplaces</h2>
        <ul className="mt-3 divide-y divide-line">
          {PLATFORMS.filter(p => p.id !== "other").map(p => (
            <li key={p.id} className="py-3">
              <p className="text-sm text-white">
                {p.name}
                {p.hasAccount && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">account set up</span>}
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
