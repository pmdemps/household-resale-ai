"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Send } from "lucide-react";
import { preparePush, removePushSubscription, savePushSubscription, sendTestPush } from "@/app/push-actions";
import { pushSupport, sameServerKey, urlBase64ToBytes } from "@/lib/push/browser";
import { deviceLabelFromUserAgent } from "@/lib/push/notify";

type State = "checking" | "needs-install" | "unsupported" | "denied" | "off" | "on";

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

function save(sub: PushSubscription, device: string) {
  const keys = sub.toJSON().keys ?? {};
  return savePushSubscription({ endpoint: sub.endpoint, p256dh: keys.p256dh ?? "", auth: keys.auth ?? "", device });
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e)).slice(0, 200);

/**
 * The per-phone half of Settings → "Phone buzzes": asks the phone for permission, subscribes it with the
 * household's key and saves the subscription. Each phone is its own switch.
 */
export function PushToggle() {
  const [state, setState] = useState<State>("checking");
  const [device, setDevice] = useState("phone");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const label = deviceLabelFromUserAgent(navigator.userAgent, navigator.maxTouchPoints);
    setDevice(label);
    (async (): Promise<State> => {
      const support = pushSupport();
      if (support !== "supported") return support;
      if (Notification.permission === "denied") return "denied";
      const sub = await currentSubscription();
      if (!sub || Notification.permission !== "granted") return "off";
      // Quietly re-save so the database matches this phone (and knows who is signed in on it now).
      await save(sub, label).catch(() => null);
      return "on";
    })()
      .then(s => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState("off"); });
    return () => { cancelled = true; };
  }, []);

  async function run(job: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const turnOn = () => run(async () => {
    // Ask straight from the tap: iPhone only shows the permission prompt for a direct user action.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState(permission === "denied" ? "denied" : "off");
      return;
    }
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const reg = await navigator.serviceWorker.ready;
    const prep = await preparePush();
    if (!prep.ok) throw new Error(prep.error);
    if (!prep.publicKey) throw new Error("No key came back from the server.");
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameServerKey(sub.options.applicationServerKey, prep.publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(prep.publicKey) });
    const saved = await save(sub, device);
    if (!saved.ok) throw new Error(saved.error);
    setState("on");
    setNote("Done. Hit Send a test to make sure this shit actually works.");
  });

  const test = () => run(async () => {
    const r = await sendTestPush();
    if (!r.ok) throw new Error(r.error);
    if (!r.devices) {
      setState("off");
      setNote("This phone fell off our list. Turn it on again.");
      return;
    }
    setNote("Sent. It should pop up in a few seconds. Nothing after a minute? Turn it off and on again.");
  });

  const turnOff = () => run(async () => {
    const sub = await currentSubscription();
    if (sub) {
      const r = await removePushSubscription(sub.endpoint);
      if (!r.ok) throw new Error(r.error);
      await sub.unsubscribe().catch(() => false);
    }
    setState("off");
    setNote("Off for this phone. No more buzzes here.");
  });

  return (
    <div className="mt-4">
      {state === "checking" && <p className="text-sm text-slate-400">Checking this {device}…</p>}

      {state === "needs-install" && (
        <div className="rounded-xl border border-line bg-white/[0.03] p-4 text-sm leading-6 text-slate-300">
          <p className="font-medium text-white">On iPhone this only works from the home-screen app, not from Safari.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>In Safari, tap <span className="text-slate-100">Share</span> (on newer iPhones it&apos;s under the <span className="text-slate-100">•••</span> button), then <span className="text-slate-100">Add to Home Screen</span>.</li>
            <li>Leave <span className="text-slate-100">Open as Web App</span> on and tap <span className="text-slate-100">Add</span>.</li>
            <li>Open Resale HQ from the new icon, sign in, and come back to Settings. The button shows up there.</li>
          </ol>
        </div>
      )}

      {state === "unsupported" && (
        <p className="text-sm text-slate-400">This browser can&apos;t do push notifications for shit. Use the home-screen app on your phone instead.</p>
      )}

      {state === "denied" && (
        <p className="text-sm leading-6 text-slate-300">
          This phone told us to fuck off. To fix it: iPhone <span className="text-slate-100">Settings → Notifications → Resale HQ</span>, turn on
          {" "}<span className="text-slate-100">Allow Notifications</span>, then come back here.
        </p>
      )}

      {state === "off" && (
        <button type="button" className="btn-primary" onClick={turnOn} disabled={busy}>
          <Bell size={15} /> {busy ? "Setting it up…" : "Turn on notifications"}
        </button>
      )}

      {state === "on" && (
        <div className="space-y-3">
          <p className="text-sm text-good">Hell yeah, this {device} buzzes when some shit needs us.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={test} disabled={busy}><Send size={15} /> Send a test</button>
            <button type="button" className="btn-secondary" onClick={turnOff} disabled={busy}><BellOff size={15} /> Turn it off on this phone</button>
          </div>
        </div>
      )}

      {note && <p className="mt-2 text-sm text-slate-300">{note}</p>}
      {error && <p className="mt-2 text-sm text-warn">Well, shit: {error}</p>}
    </div>
  );
}
