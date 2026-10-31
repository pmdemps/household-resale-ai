import Link from "next/link";
import { NoteComposer, NotesList } from "@/components/notes";
import { requireHousehold } from "@/lib/household";
import { loadMemberNames, loadNotes } from "@/lib/queries";

const VIEWS = [
  { id: "all", label: "Everything" },
  { id: "general", label: "General" },
  { id: "items", label: "On items" },
] as const;

export default async function NotesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requireHousehold();
  const { view = "all" } = await searchParams;
  const [allNotes, names] = await Promise.all([loadNotes(ctx, { limit: 300 }), loadMemberNames(ctx)]);
  const notes = view === "general" ? allNotes.filter(n => !n.item_id) : view === "items" ? allNotes.filter(n => n.item_id) : allNotes;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Notes</h1>
        <p className="mt-1 text-sm text-slate-400">
          Just us. Reminders, &quot;don&apos;t you dare sell this,&quot; who&apos;s shipping what. Buyers and marketplaces never see any of it.
        </p>
      </header>
      <section className="surface p-4">
        <NoteComposer />
      </section>
      <nav className="flex gap-1">
        {VIEWS.map(v => (
          <Link key={v.id} href={{ pathname: "/notes", query: v.id === "all" ? {} : { view: v.id } }}
            className={"rounded-full px-3 py-1.5 text-sm " + (view === v.id ? "bg-accent/20 font-medium text-white" : "text-slate-400 hover:text-white")}>
            {v.label}
          </Link>
        ))}
      </nav>
      <NotesList notes={notes} names={names} currentUser={ctx.userId} isAdmin={ctx.role === "admin"} />
    </div>
  );
}
