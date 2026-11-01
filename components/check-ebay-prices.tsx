"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { checkEbayPrices } from "@/app/comps-actions";

/** "Check eBay prices" button for the comps card: runs the search, then refreshes the page with the results. */
export function CheckEbayPricesButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function run() {
    setMessage(null);
    start(async () => {
      const form = new FormData();
      form.set("item_id", itemId);
      const res = await checkEbayPrices(form);
      if (res.error) setMessage({ tone: "error", text: res.error });
      else {
        setMessage({ tone: "ok", text: res.found ? `Found ${res.found} on eBay.` : "Nothing similar on eBay right now." });
        router.refresh();
      }
    });
  }

  return (
    <>
      <button type="button" onClick={run} disabled={pending} className="btn-secondary">
        {pending ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} {pending ? "Checking eBay…" : "Check eBay prices"}
      </button>
      {message && <p role="status" className={"text-xs " + (message.tone === "error" ? "text-bad" : "text-slate-400")}>{message.text}</p>}
    </>
  );
}
