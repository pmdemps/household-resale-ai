"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { createAssistantKey, type NewKeyState } from "@/app/assistant-actions";

/**
 * "Make a key" form plus the one-time reveal. The key comes back from the server action and lives only in
 * this component's state: never in the URL, never stored anywhere but the person's assistant.
 */
export function NewAssistantKey({ endpoint, docUrl }: { endpoint: string; docUrl: string }) {
  const [state, action, pending] = useActionState<NewKeyState, FormData>(createAssistantKey, null);
  const [copied, setCopied] = useState<"key" | "url" | null>(null);

  async function copy(what: "key" | "url", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard blocked; the value is on screen to copy by hand.
    }
  }

  if (state?.token) {
    return (
      <div className="mt-4 rounded-xl border border-good/30 bg-good/10 p-4">
        <p className="text-sm font-medium text-white">Here&apos;s the key for {state.label}. Copy this shit now, we only show it once.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="break-all rounded-lg bg-ink px-3 py-2 text-sm text-slate-100">{state.token}</code>
          <button type="button" className="btn-secondary" onClick={() => copy("key", state.token!)}>
            {copied === "key" ? <Check size={14} /> : <Copy size={14} />} {copied === "key" ? "Copied" : "Copy key"}
          </button>
        </div>
        <p className="mt-3 text-sm text-slate-300">Your assistant also needs the address it talks to:</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="break-all rounded-lg bg-ink px-3 py-2 text-sm text-slate-100">{endpoint}</code>
          <button type="button" className="btn-secondary" onClick={() => copy("url", endpoint)}>
            {copied === "url" ? <Check size={14} /> : <Copy size={14} />} {copied === "url" ? "Copied" : "Copy address"}
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          Paste the key, the address and the{" "}
          <a href={docUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">setup instructions</a>
          {" "}into your assistant. If the key ever leaks, hit <span className="text-slate-200">Cut it off</span> above and make a new one.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4 flex flex-wrap items-end gap-2">
      <label className="min-w-[10rem] flex-1 text-xs text-slate-400">
        What do you call it?
        <input name="label" maxLength={40} defaultValue="muse" className="field mt-1" placeholder="muse" />
      </label>
      <button className="btn-primary" disabled={pending}><Plus size={15} /> {pending ? "Making it…" : "Make a key"}</button>
      {state?.error && <p className="w-full text-sm text-warn">Well, shit: {state.error}</p>}
    </form>
  );
}
