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
        <h1 className="mt-2 text-2xl font-semibold text-white">Create your household</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Everything you track lives in a shared household. You can add another account (like a partner) from Settings afterwards.
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
