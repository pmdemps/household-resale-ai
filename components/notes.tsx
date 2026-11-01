import Link from "next/link";
import { Pin, PinOff, Send, Trash2 } from "lucide-react";
import { addNote, deleteNote, toggleNotePin } from "@/app/actions";
import type { MemberNames } from "@/lib/queries";
import { timeAgo, type Note } from "@/lib/types";

type NoteRow = Note & { inventory_items?: { id: string; name: string } | null };

const AVATAR_COLORS = ["bg-accent/20 text-link", "bg-pop/20 text-pop", "bg-good/20 text-good", "bg-warn/20 text-warn"];

function avatarColor(userId: string, names: MemberNames) {
  const idx = Object.keys(names).indexOf(userId);
  return AVATAR_COLORS[(idx < 0 ? 0 : idx) % AVATAR_COLORS.length];
}

export function NoteComposer({ itemId, placeholder }: { itemId?: string; placeholder?: string }) {
  return (
    <form action={addNote} className="flex items-end gap-2">
      {itemId && <input type="hidden" name="item_id" value={itemId} />}
      <textarea
        name="body"
        required
        maxLength={4000}
        rows={2}
        className="field min-h-[2.75rem] flex-1 resize-y"
        placeholder={placeholder ?? "Talk your shit…"}
        aria-label="Note"
      />
      <button className="btn-primary h-11 shrink-0" aria-label="Post note"><Send size={16} /></button>
    </form>
  );
}

export function NotesList({
  notes,
  names,
  currentUser,
  isAdmin,
  showItem = true,
  allowPin = true,
}: {
  notes: NoteRow[];
  names: MemberNames;
  currentUser: string;
  isAdmin: boolean;
  showItem?: boolean;
  allowPin?: boolean;
}) {
  if (notes.length === 0) return <p className="text-sm text-slate-500">Crickets.</p>;
  return (
    <ul className="space-y-3">
      {notes.map(n => {
        const name = names[n.author] ?? "Former member";
        const mine = n.author === currentUser;
        return (
          <li key={n.id} className={"rounded-xl border p-3.5 " + (n.pinned ? "border-warn/25 bg-warn/[0.04]" : "border-line bg-ink/40")}>
            <div className="flex items-start gap-3">
              <span className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold " + avatarColor(n.author, names)} aria-hidden>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium text-slate-200">{mine ? `${name} (you)` : name}</span>
                  <time dateTime={n.created_at} className="text-slate-500">{timeAgo(n.created_at)}</time>
                  {n.pinned && <span className="inline-flex items-center gap-1 text-warn"><Pin size={11} /> pinned</span>}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{n.body}</p>
                {showItem && n.inventory_items && (
                  <Link href={`/inventory/${n.inventory_items.id}`} className="mt-1.5 inline-block rounded-md bg-white/[0.05] px-2 py-0.5 text-xs text-link hover:underline">
                    on {n.inventory_items.name}
                  </Link>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {allowPin && (
                  <form action={toggleNotePin}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="pinned" value={String(!n.pinned)} />
                    <button className="rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-white" aria-label={n.pinned ? "Unpin" : "Pin"} title={n.pinned ? "Unpin" : "Pin to top"}>
                      {n.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                    </button>
                  </form>
                )}
                {(mine || isAdmin) && (
                  <form action={deleteNote}>
                    <input type="hidden" name="id" value={n.id} />
                    {n.item_id && <input type="hidden" name="item_id" value={n.item_id} />}
                    <button className="rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-bad" aria-label="Delete note" title="Delete">
                      <Trash2 size={15} />
                    </button>
                  </form>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
