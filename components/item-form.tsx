import { CATEGORIES, CONDITIONS, ITEM_STATUSES, type InventoryItem } from "@/lib/types";

type Props = {
  action: (form: FormData) => Promise<void>;
  item?: InventoryItem;
};

export function ItemForm({ action, item }: Props) {
  const editing = Boolean(item);
  return (
    <form action={action} className="space-y-5">
      {item && <input type="hidden" name="id" value={item.id} />}
      <Field label="What is it?" htmlFor="name">
        <input id="name" name="name" className="field" required maxLength={200} defaultValue={item?.name} placeholder="Boys' Nike Air Max sneakers" autoFocus={!editing} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Category" htmlFor="category">
          <select id="category" name="category" className="field" defaultValue={item?.category ?? "Clothing"}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Brand" htmlFor="brand">
          <input id="brand" name="brand" className="field" maxLength={120} defaultValue={item?.brand ?? ""} placeholder="Nike" />
        </Field>
        <Field label="Size" htmlFor="size">
          <input id="size" name="size" className="field" maxLength={40} defaultValue={item?.size ?? ""} placeholder="Youth 4" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Condition" htmlFor="condition">
          <select id="condition" name="condition" className="field" defaultValue={item?.condition ?? "Good"}>
            {CONDITIONS.map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Where is it?" htmlFor="storage_location">
          <input id="storage_location" name="storage_location" className="field" maxLength={120} defaultValue={item?.storage_location ?? ""} placeholder="Garage bin 2" />
        </Field>
        <Field label="Weight (oz)" htmlFor="weight_oz" hint="For shipping">
          <input id="weight_oz" name="weight_oz" type="number" min="0" step="0.1" inputMode="decimal" className="field" defaultValue={item?.weight_oz ?? ""} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Asking price ($)" htmlFor="target_price">
          <input id="target_price" name="target_price" type="number" min="0" step="0.01" inputMode="decimal" className="field" defaultValue={item ? item.target_price : ""} placeholder="0.00" />
        </Field>
        <Field label="Lowest you'd take ($)" htmlFor="floor_price" hint="Agents never go below this">
          <input id="floor_price" name="floor_price" type="number" min="0" step="0.01" inputMode="decimal" className="field" defaultValue={item?.floor_price ?? ""} placeholder="0.00" />
        </Field>
        <Field label="What you paid ($)" htmlFor="purchase_cost" hint="0 if you don't know">
          <input id="purchase_cost" name="purchase_cost" type="number" min="0" step="0.01" inputMode="decimal" className="field" defaultValue={item ? item.purchase_cost : ""} placeholder="0.00" />
        </Field>
      </div>

      {editing && (
        <Field label="Status" htmlFor="status">
          <select id="status" name="status" className="field" defaultValue={item!.status}>
            {ITEM_STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </Field>
      )}

      <Field label="Notes" htmlFor="notes" hint="Flaws, details, anything a buyer should know">
        <textarea id="notes" name="notes" rows={3} className="field" maxLength={4000} defaultValue={item?.notes ?? ""} />
      </Field>
      <input type="hidden" name="source" value={item?.source ?? "Household"} />

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {!editing && <button name="another" value="1" className="btn-secondary">Save &amp; add another</button>}
        <button className="btn-primary">{editing ? "Save changes" : "Save item"}</button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-2 text-xs text-slate-300">
        <span>{label}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
