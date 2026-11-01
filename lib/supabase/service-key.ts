// Pure check for the SUPABASE_SERVICE_ROLE_KEY value (no imports, so node --test can load it).
// A key pasted into Vercel can pick up surrounding text: a long dash, quotes, a label, a trailing space.
// Such a value can't be sent in an HTTP header and fails with "Cannot convert argument to a ByteString".
// We never echo the key; problems are reported by position and kind only.

export type ServiceKeyProblem = { problem: string };

/** Surrounding whitespace and a pair of wrapping quotes are harmless paste noise; strip them. */
export function cleanServiceKey(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1).trim();
  return k || null;
}

/** null when the key looks like a key; otherwise a sentence saying what's wrong, never the key itself. */
export function serviceKeyProblem(key: string | null): string | null {
  if (!key) return "SUPABASE_SERVICE_ROLE_KEY is not set.";
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      const what = c === 0x2014 || c === 0x2013 ? "a long dash" : c === 0x20 ? "a space" : c === 0x2022 ? "a dot from the hidden display" : c > 0x7e ? "a special character" : "an invisible character";
      return `SUPABASE_SERVICE_ROLE_KEY has ${what} at character ${i + 1}, which can't be part of a key. Copy it again with Supabase's copy button and paste only the key.`;
    }
  }
  if (!/^(sb_secret_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(key)) {
    return "SUPABASE_SERVICE_ROLE_KEY doesn't look like a Supabase secret key (it should start with sb_secret_ or be the long legacy service_role key starting with eyJ).";
  }
  return null;
}
