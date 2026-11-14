# Resale HQ posting helper (Chrome extension)

Fills in the sell form on **Mercari, Poshmark and Facebook Marketplace** from Resale HQ, in your own
logged-in Chrome. **It never presses Post.** You review the form and tap Post / List / Publish yourself,
then it records the live listing in Resale HQ (switch on, "Post it on …" to-do done, item marked listed).

Vinted is not supported on purpose: Vinted suspends accounts that automate its site.

## Install (once, on the computer you post from)

1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick this `extension/` folder.
3. Resale HQ → Settings → Assistant keys → make a key named `Posting helper`.
4. Click the extension's puzzle-piece icon → Resale HQ helper → **Settings**: paste the Resale HQ address
   and the key, press **Save and test**, allow the permission Chrome asks for.

## Use

1. On an item in Resale HQ, flip the Mercari / Poshmark / Facebook switch on.
2. Click the extension icon: everything switched on but not posted yet is listed. Press **Fill it in**.
3. A tab opens on the site's sell page and the helper fills title, description, price and photos.
   The panel in the corner says what to pick by hand (category, brand, size, condition, shipping).
4. Check it all and tap the site's own Post button.
   - Mercari and Poshmark: it notices the new listing page and records it automatically.
   - Facebook: press **I posted it** in the panel. Hide from friends must be ON (the helper tries to switch
     it on and warns you either way). Marketplace only, never shared.

## Limits

- These sites change their forms. When a field isn't found the panel says "do by hand"; tell an agent which
  field and site so `sites.js` can be updated.
- Some sites accept only one photo per upload; the panel says so and you add the rest.
- Your computer and Chrome have to be on. It doesn't run from the phone.
- Using any helper on these sites is against their terms; it's the household's call and risk (AGENTS.md).
