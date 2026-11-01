// Item page → "Where do we want this?" One switch per marketplace. Server component: each switch is a
// tiny form posting to setPlatformWant, so it works without JavaScript and on the phones.
// Three states per platform: live there, wanted but not up yet (a to-do is out), or off.

import { Check, Clock, Power } from "lucide-react";
import { setPlatformWant } from "@/app/platform-actions";
import { PLATFORMS, platformById } from "@/lib/platforms";
import type { AgentTask, Listing } from "@/lib/types";

type Want = { platform: string; wanted: boolean };

type Props = {
  itemId: string;
  category: string;
  listings: Listing[];
  wants: Want[];
  /** Pending to-dos for this item (post / pull), so a switch can say "to-do out" instead of lying. */
  pendingTasks: Pick<AgentTask, "kind" | "payload">[];
  ebayConnected: boolean;
};

const LIVE = ["draft", "active", "paused"];

export function PlatformToggles({ itemId, category, listings, wants, pendingTasks, ebayConnected }: Props) {
  const livePlatforms = new Set(listings.filter(l => LIVE.includes(l.status)).map(l => l.platform));
  const wantMap = new Map(wants.map(w => [w.platform, w.wanted]));
  const pendingFor = (platform: string, kind: string) => pendingTasks.some(t => t.kind === kind && (t.payload as { platform?: string })?.platform === platform);
  const rows = PLATFORMS.filter(p => p.id !== "other").map(p => {
    const live = livePlatforms.has(p.id);
    const wanted = wantMap.has(p.id) ? wantMap.get(p.id)! : live; // no switch set yet: live means on
    const toDo = wanted ? pendingFor(p.id, "listing_draft") : pendingFor(p.id, "delist");
    const badFit = p.avoidCategories?.includes(category) ?? false;
    return { p, live, wanted, toDo, badFit };
  });
  const onCount = rows.filter(r => r.wanted).length;

  return (
    <section className="surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-white">Where do we want this shit?</h2>
        <span className="text-xs text-slate-500">{onCount === 0 ? "Nowhere yet" : `${onCount} on`}</span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        Flip one on and it goes up: eBay posts itself{ebayConnected ? "" : " once it's connected"}, the rest become a to-do with the text ready to paste. Flip one off and it comes down the same way.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {rows.map(({ p, live, wanted, toDo, badFit }) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">
                {p.name}
                {badFit && <span className="ml-2 text-[11px] font-normal text-warn">bad fit for {category.toLowerCase()}</span>}
              </p>
              <p className="text-xs text-slate-500">
                {live && wanted && <span className="inline-flex items-center gap-1 text-good"><Check size={12} /> Live</span>}
                {live && !wanted && <span className="inline-flex items-center gap-1 text-warn"><Clock size={12} /> {toDo ? "Still up, to-do out to pull it" : "Still up"}</span>}
                {!live && wanted && <span className="inline-flex items-center gap-1 text-warn"><Clock size={12} /> {toDo ? "Not up yet, to-do out to post it" : "Not up yet"}</span>}
                {!live && !wanted && <span className="text-slate-500">Off</span>}
              </p>
            </div>
            <form action={setPlatformWant}>
              <input type="hidden" name="item_id" value={itemId} />
              <input type="hidden" name="platform" value={p.id} />
              <input type="hidden" name="wanted" value={wanted ? "0" : "1"} />
              <button
                type="submit"
                role="switch"
                aria-checked={wanted}
                aria-label={`${wanted ? "Turn off" : "Turn on"} ${platformById(p.id).name}`}
                className={
                  "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors " +
                  (wanted ? "border-accent bg-accent" : "border-line bg-white/[0.06]")
                }
              >
                <span className={"inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-ink shadow transition-transform " + (wanted ? "translate-x-6" : "translate-x-1")}>
                  <Power size={11} />
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
