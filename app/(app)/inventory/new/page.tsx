import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { createItem } from "@/app/actions";
import { ItemForm } from "@/components/item-form";

export default async function NewItemPage({ searchParams }: { searchParams: Promise<{ added?: string }> }) {
  const { added } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <Link href="/inventory" className="text-sm text-link hover:underline">← Inventory</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">Add an item</h1>
      </header>
      {added && (
        <p className="flex items-center gap-2 rounded-xl border border-good/20 bg-good/[0.07] px-4 py-2.5 text-sm text-good">
          <CheckCircle2 size={16} /> Saved. Next one.
        </p>
      )}
      <section className="surface p-5 sm:p-6">
        <ItemForm action={createItem} key={added ?? "first"} />
      </section>
    </div>
  );
}
