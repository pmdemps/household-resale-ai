import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PHOTO_BUCKET, photoStoragePath } from "@/lib/photo-url";
import { normalizePhoto } from "@/lib/assistant/photos";
import { AssistantApiError } from "@/lib/assistant/server";

// Photos an SQL-only agent queued in photo_inbox (migration 20261114000000_photo_inbox.sql). The database
// pokes /api/photos/inbox after each insert; this claims the waiting rows with the household's dispatch
// token, re-encodes each photo like assistant photos, uploads it with the service role, and reports back.
// A failed photo keeps its inbox row with the reason and is retried (at most 3 tries) on the next poke.

export type InboxSummary = { claimed: number; stored: number; failed: number };

type Claimed = { inbox_id: string; item_id: string; photo_base64: string };

export class InboxError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function reason(e: unknown): string {
  if (e instanceof AssistantApiError) return e.failure.error;
  return (e as Error)?.message?.slice(0, 300) || "unknown error";
}

export async function processPhotoInbox(db: SupabaseClient, storage: SupabaseClient, householdId: string, token: string): Promise<InboxSummary> {
  const { data, error } = await db.rpc("photo_inbox_claim", { p_household_id: householdId, p_token: token });
  if (error) {
    if (error.code === "28000") throw new InboxError("Invalid token", 403);
    throw new InboxError(`Claim failed: ${error.message}`, 500);
  }
  const items: Claimed[] = Array.isArray(data?.items) ? data.items : [];
  const summary: InboxSummary = { claimed: items.length, stored: 0, failed: 0 };

  for (const item of items) {
    let path: string | null = null;
    try {
      const bytes = new Uint8Array(Buffer.from(item.photo_base64, "base64"));
      const photo = await normalizePhoto(bytes);
      path = photoStoragePath(householdId, item.item_id, randomUUID(), "jpg");
      const { error: upErr } = await storage.storage.from(PHOTO_BUCKET).upload(path, photo.data, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" });
      if (upErr) throw new Error(`Couldn't store the photo: ${upErr.message}`);
      const { error: doneErr } = await db.rpc("photo_inbox_done", {
        p_household_id: householdId, p_token: token, p_inbox_id: item.inbox_id,
        p_storage_path: path, p_width: photo.width, p_height: photo.height, p_bytes: photo.data.byteLength,
      });
      if (doneErr) throw new Error(doneErr.message);
      summary.stored++;
    } catch (e) {
      summary.failed++;
      if (path) await storage.storage.from(PHOTO_BUCKET).remove([path]).catch(() => {});
      await db.rpc("photo_inbox_done", { p_household_id: householdId, p_token: token, p_inbox_id: item.inbox_id, p_error: reason(e) });
    }
  }
  return summary;
}
