"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      const supabase = createClient();
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.assign("/");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/auth/callback" },
        });
        if (error) throw error;
        setMessage("Account request submitted. Check your email for a confirmation link if email confirmation is enabled.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to complete sign-in. Check your Supabase configuration.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="flex min-h-screen items-center justify-center px-4 py-10">
    <section className="surface w-full max-w-md p-7 sm:p-8">
      <Link href="/" className="text-sm text-accent hover:underline">← Resale HQ</Link>
      <p className="eyebrow mt-7">Household Resale AI</p>
      <h1 className="mt-2 text-2xl font-semibold text-white">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">Sign in to your workspace. Your inventory will be protected by account-level database policies.</p>
      <div className="mt-6 grid grid-cols-2 rounded-xl border border-line p-1">
        <button type="button" onClick={() => { setMode("signin"); setMessage(""); }} className={"rounded-lg py-2 text-sm " + (mode === "signin" ? "bg-white/10 text-white" : "text-slate-400")}>Sign in</button>
        <button type="button" onClick={() => { setMode("signup"); setMessage(""); }} className={"rounded-lg py-2 text-sm " + (mode === "signup" ? "bg-white/10 text-white" : "text-slate-400")}>Create account</button>
      </div>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <div><label htmlFor="email" className="mb-1.5 block text-xs text-slate-300">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} className="field" placeholder="you@example.com" /></div>
        <div><label htmlFor="password" className="mb-1.5 block text-xs text-slate-300">Password</label><input id="password" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} className="field" placeholder="At least 8 characters" /></div>
        <button disabled={busy} className="btn-primary w-full disabled:cursor-wait disabled:opacity-60" type="submit">{busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}</button>
      </form>
      {message && <p role="status" className="mt-4 rounded-xl border border-line bg-white/[0.03] p-3 text-sm leading-5 text-slate-300">{message}</p>}
      <p className="mt-5 text-xs leading-5 text-slate-500">New accounts may require email confirmation. Configure the site URL and redirect URL in Supabase Auth settings before production use.</p>
    </section>
  </main>;
}
