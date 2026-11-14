const $ = id => document.getElementById(id);
const msg = t => { $("msg").textContent = t; };

chrome.storage.local.get(["appUrl", "key"]).then(({ appUrl = "", key = "" }) => { $("appUrl").value = appUrl; $("key").value = key; });

$("save").onclick = async () => {
  let origin;
  try {
    const u = new URL($("appUrl").value.trim());
    if (u.protocol !== "https:") throw new Error();
    origin = u.origin;
  } catch {
    return msg("The address must look like https://something.vercel.app");
  }
  const key = $("key").value.trim();
  if (!key) return msg("Paste the key from Resale HQ Settings.");
  // Ask Chrome for permission to talk to this one address (needs a click, so it happens here).
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return msg("Chrome needs permission to reach Resale HQ. Press Save again and allow it.");
  await chrome.storage.local.set({ appUrl: origin, key });
  chrome.runtime.sendMessage({ type: "queue" }, r => {
    msg(r && r.ok ? `Connected ✔ ${r.say}` : `Saved, but the test failed: ${r ? r.error : chrome.runtime.lastError?.message}`);
  });
};
