"use client";

// Item page → "Post it ourselves". For marketplaces with no API (Poshmark, Mercari, OfferUp,
// Facebook, Vinted, ThredUp): Resale HQ writes the listing, a human pastes it into the platform's
// own app, then taps "We posted it" so the listing is tracked here and gets pulled if it sells elsewhere.
// We never automate those sites (AGENTS.md). Pasted text is buyer-facing, so it stays clean.

import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Package, Plus } from "lucide-react";
import { addListing } from "@/app/actions";
import { buildListingCopy, type CopyItem } from "@/lib/listing-copy";
import { MANUAL_PLATFORMS } from "@/lib/platforms";
import { money } from "@/lib/types";

type Props = {
  item: CopyItem & { id: string };
  /** Platforms this item already has a live or draft listing on. */
  livePlatforms: string[];
  photoUrls: string[];
};

export function PostItOurselves({ item, livePlatforms, photoUrls }: Props) {
  const options = useMemo(() => MANUAL_PLATFORMS.filter(p => !livePlatforms.includes(p.id)), [livePlatforms]);
  const firstGood = options.find(p => !p.avoidCategories?.includes(item.category)) ?? options[0];
  const [pid, setPid] = useState(firstGood?.id ?? "");
  const platform = options.find(p => p.id === pid) ?? firstGood;
  if (!platform) return null; // already on every manual platform

  const copy = buildListingCopy(platform.id, item);
  const badFit = platform.avoidCategories?.includes(item.category);

  return (
    <section className="surface p-5">
      <h2 className="text-base font-semibold text-white">Post it ourselves</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        These sites have no way for apps to post, and bots get accounts banned. So we write the shit, you paste it, and the app keeps track.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Marketplace">
        {options.map(p => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === platform.id}
            onClick={() => setPid(p.id)}
            className={"rounded-full border px-3 py-1 text-xs " + (p.id === platform.id ? "border-accent bg-accent/20 text-white" : "border-line text-slate-300 hover:bg-white/[0.05]")}
          >
            {p.name}
          </button>
        ))}
      </div>

      {badFit && (
        <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {platform.name} isn&apos;t a good spot for {item.category.toLowerCase()}. It&apos;ll probably just sit there or get pulled.
        </p>
      )}

      {copy ? (
        <div className="mt-4 space-y-3">
          <CopyField label="Title" value={copy.title} />
          <CopyField label="Description" value={copy.description} multiline />
          <p className="text-sm text-slate-300">Price to ask: <span className="font-semibold text-white">{money(copy.price)}</span></p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-slate-400">
            {copy.tips.map(t => <li key={t}>{t}</li>)}
            {platform.postingRules.map(r => <li key={r} className="text-slate-300">{r}</li>)}
          </ul>
        </div>
      ) : (
        <div className="mt-4 space-y-2 text-sm text-slate-300">
          <p className="flex items-center gap-2 font-medium text-white"><Package size={15} /> Bag it for ThredUp</p>
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-slate-400">
            <li>Order a free Clean Out kit (or print a label) on ThredUp.</li>
            <li>Toss in clothes, shoes and accessories that aren&apos;t worth photographing. Clean, no stains or holes.</li>
            <li>Pick &quot;donate unsold&quot; unless we want rejects mailed back at $5.99 a pop.</li>
            <li>Tap &quot;We bagged it&quot; below. When ThredUp pays out, mark it sold with what they actually paid.</li>
          </ol>
          {platform.postingRules.map(r => <p key={r} className="text-xs text-slate-300">{r}</p>)}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {platform.sellUrl && (
          <a href={platform.sellUrl} target="_blank" rel="noreferrer" className="btn-secondary">
            Open {platform.name} <ExternalLink size={14} />
          </a>
        )}
        {photoUrls.length > 0 && copy && (
          <span className="text-xs text-slate-400">
            Photos:{" "}
            {photoUrls.map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" download className="mr-2 text-link hover:underline">#{i + 1}</a>
            ))}
          </span>
        )}
      </div>

      <form action={addListing} className="mt-4 rounded-xl border border-dashed border-line p-4">
        <input type="hidden" name="item_id" value={item.id} />
        <input type="hidden" name="platform" value={platform.id} />
        <input type="hidden" name="status" value="active" />
        {platform.consignment ? (
          <input type="hidden" name="list_price" value="0" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-[7rem_1fr]">
            <label className="flex flex-col text-xs text-slate-400">Price we listed at
              <input name="list_price" type="number" min="0" step="0.01" required defaultValue={copy ? copy.price.toFixed(2) : ""} className="field mt-1" inputMode="decimal" />
            </label>
            <label className="flex flex-col text-xs text-slate-400">Link to the listing (optional)
              <input name="listing_url" type="url" className="field mt-1" placeholder="https://" />
            </label>
          </div>
        )}
        <button className="btn-primary mt-3">
          <Plus size={15} /> {platform.consignment ? "We bagged it" : `We posted it on ${platform.name}`}
        </button>
        <p className="mt-2 text-[11px] text-slate-500">If it sells anywhere else, the app adds a to-do to pull this one down so we don&apos;t sell the same shit twice.</p>
      </form>
    </section>
  );
}

function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copyIt = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">{label}</p>
        <button type="button" onClick={copyIt} className="inline-flex items-center gap-1 text-xs text-link hover:underline">
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      {multiline ? (
        <textarea readOnly value={value} rows={Math.min(10, value.split("\n").length + 1)} className="field mt-1 font-mono text-xs" onFocus={e => e.currentTarget.select()} />
      ) : (
        <input readOnly value={value} className="field mt-1" onFocus={e => e.currentTarget.select()} />
      )}
    </div>
  );
}
