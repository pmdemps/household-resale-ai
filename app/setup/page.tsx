import { redirect } from "next/navigation";
import { createHousehold } from "@/app/actions";
import { getContext, isSupabaseConfigured } from "@/lib/household";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!isSupabaseConfigured()) redirect("/");
  const ctx = await getContext();
  if (ctx.household) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="surface w-full max-w-md p-7">
        <p className="eyebrow">Welcome</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">Start a household</h1>
        <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-sm leading-6 text-slate-200">
          <span className="font-semibold text-warn">Joining someone else&apos;s?</span> Don&apos;t make one here. Tell them the email you just signed up
          with{ctx.email ? <> (<span className="font-medium text-white">{ctx.email}</span>)</> : null}. Once they add you in their Settings, sign in again and you&apos;re in.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Starting fresh? Everything you track lives in one shared household. You can add your partner in crime from Settings afterwards.
        </p>
        <form action={createHousehold} className="mt-6 space-y-4">
          <div>
            <label htmlFor="name" className="mb-1.5 block text-xs text-slate-300">Household name</label>
            <input id="name" name="name" className="field" placeholder="Our house" maxLength={120} required />
          </div>
          <div>
            <label htmlFor="display_name" className="mb-1.5 block text-xs text-slate-300">Your first name</label>
            <input id="display_name" name="display_name" className="field" maxLength={40} placeholder="Shown on your notes" />
          </div>
          <button className="btn-primary w-full">Create household</button>
        </form>
        <p className="mt-4 text-xs text-slate-500">Signed in as {ctx.email}</p>
      </section>
    </main>
  );
}
