"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImagePlus, Loader2 } from "lucide-react";
import { recordItemPhoto } from "@/app/photo-actions";
import { preparePhoto, randomUuid } from "@/lib/photo-client";
import { MAX_PHOTOS_PER_ITEM, PHOTO_BUCKET, photoStoragePath } from "@/lib/photo-url";
import { createClient } from "@/lib/supabase/client";

/**
 * "Add photos" for an existing item. Picking files starts straight away, so on a phone it's: tap, choose
 * (or shoot), done. Two hidden inputs: the library picker (multiple) and a camera shortcut.
 *
 * Each photo is resized in the browser (longest side 2000px, JPEG) and uploaded from the browser directly
 * to Supabase Storage with the member's session — never through a server action, which Vercel caps at
 * 4.5 MB per request. Only then does recordItemPhoto (a small server action) write the item_photos row.
 */
export function PhotoUploader({ householdId, itemId, photoCount, compact = false }: { householdId: string; itemId: string; photoCount: number; compact?: boolean }) {
  const router = useRouter();
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [added, setAdded] = useState(0);
  const busy = progress !== null;

  async function handleFiles(input: HTMLInputElement | null) {
    const files = Array.from(input?.files ?? []).filter(f => f.size > 0);
    if (input) input.value = ""; // so the same photo can be picked again after an error
    if (files.length === 0 || busy) return;

    const room = MAX_PHOTOS_PER_ITEM - photoCount;
    const problems: string[] = [];
    if (room <= 0) {
      setErrors([`This item already has ${MAX_PHOTOS_PER_ITEM} photos. Delete one to add another.`]);
      return;
    }
    const batch = files.slice(0, room);
    if (files.length > room) problems.push(`Only ${room} more photo${room === 1 ? "" : "s"} fit (${MAX_PHOTOS_PER_ITEM} per item), so the first ${room} were uploaded.`);

    setErrors([]);
    setAdded(0);
    let ok = 0;
    try {
      const supabase = createClient();
      for (const [i, file] of batch.entries()) {
        setProgress({ current: i + 1, total: batch.length });
        try {
          const prepared = await preparePhoto(file);
          const path = photoStoragePath(householdId, itemId, randomUuid(), prepared.ext);
          const { error: upErr } = await supabase.storage
            .from(PHOTO_BUCKET)
            .upload(path, prepared.blob, { contentType: prepared.contentType, upsert: false, cacheControl: "31536000" });
          if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

          const form = new FormData();
          form.set("item_id", itemId);
          form.set("storage_path", path);
          form.set("content_type", prepared.contentType);
          form.set("bytes", String(prepared.blob.size));
          if (prepared.width) form.set("width", String(prepared.width));
          if (prepared.height) form.set("height", String(prepared.height));
          const result = await recordItemPhoto(form);
          if (result.error) throw new Error(result.error);
          ok++;
        } catch (e) {
          problems.push(`${file.name || `Photo ${i + 1}`}: ${e instanceof Error ? e.message : "upload failed."}`);
        }
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setProgress(null);
    }
    setErrors(problems);
    setAdded(ok);
    if (ok > 0) router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input ref={libraryRef} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={() => handleFiles(libraryRef.current)} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={() => handleFiles(cameraRef.current)} />
      {progress ? (
        <span className="btn-secondary cursor-progress whitespace-nowrap" aria-live="polite">
          <Loader2 size={15} className="animate-spin" /> Uploading {progress.current} of {progress.total}…
        </span>
      ) : (
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={() => cameraRef.current?.click()} className="btn-secondary px-2.5 sm:hidden" aria-label="Take a photo" title="Take a photo">
            <Camera size={16} />
          </button>
          <button type="button" onClick={() => libraryRef.current?.click()} className="btn-secondary whitespace-nowrap">
            <ImagePlus size={15} /> {compact ? "Photos" : "Add photos"}
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="max-w-[18rem] space-y-1 text-right text-xs text-bad">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {!busy && errors.length === 0 && added > 0 ? <p className="text-xs text-good">Added {added} photo{added === 1 ? "" : "s"}.</p> : null}
    </div>
  );
}
