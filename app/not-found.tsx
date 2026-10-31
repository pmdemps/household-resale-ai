import Link from "next/link";

/** 404: an item that was deleted, a mistyped link, or a page that never existed. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="surface w-full max-w-md p-7 text-center">
        <p className="text-4xl" aria-hidden>🤷</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">This shit doesn&apos;t exist.</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">Maybe we deleted it, maybe the link is busted. Either way, it&apos;s not here.</p>
        <Link href="/" className="btn-primary mt-5">Take me home</Link>
      </section>
    </main>
  );
}
