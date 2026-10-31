"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";

/** Shown when a signed-in page or a button blows up. In production the real message is hidden, so keep it friendly. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="surface mx-auto mt-6 max-w-lg p-6 text-center sm:p-8">
      <p className="text-4xl" aria-hidden>💩</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Well, shit.</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        Something broke. Try again, and if it keeps happening, tell Claude what you were doing.
      </p>
      {!error.digest && error.message && <p className="mt-3 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-slate-400">{error.message}</p>}
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" onClick={reset} className="btn-primary"><RotateCcw size={15} /> Try again</button>
        <Link href="/" className="btn-secondary">Go home</Link>
      </div>
      {error.digest && <p className="mt-4 text-[11px] text-slate-500">Error code {error.digest}</p>}
    </section>
  );
}
