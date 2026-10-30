"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Camera, ImagePlus, Loader2 } from "lucide-react";
import { uploadItemPhotos, type PhotoActionState } from "@/app/photo-actions";

/**
 * "Add photos" for an existing item. Picking files submits straight away, so on a phone it's:
 * tap, choose (or shoot), done. Two hidden inputs: the library picker (multiple) and a camera shortcut.
 */
export function PhotoUploader({ itemId, compact = false }: { itemId: string; compact?: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [state, action] = useActionState<PhotoActionState, FormData>(uploadItemPhotos, { error: null });
  const submitIfPicked = (input: HTMLInputElement | null) => {
    if (input?.files?.length) formRef.current?.requestSubmit();
  };

  return (
    <form ref={formRef} action={action} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="item_id" value={itemId} />
      <input ref={libraryRef} type="file" name="files" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={() => submitIfPicked(libraryRef.current)} />
      <input ref={cameraRef} type="file" name="files" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={() => submitIfPicked(cameraRef.current)} />
      <Buttons compact={compact} onLibrary={() => libraryRef.current?.click()} onCamera={() => cameraRef.current?.click()} />
      {state.error && <p role="alert" className="max-w-[16rem] text-right text-xs text-bad">{state.error}</p>}
      {state.error === null && state.added ? <p className="text-xs text-good">Added {state.added} photo{state.added === 1 ? "" : "s"}.</p> : null}
    </form>
  );
}

function Buttons({ compact, onLibrary, onCamera }: { compact: boolean; onLibrary: () => void; onCamera: () => void }) {
  const { pending } = useFormStatus();
  if (pending) {
    return (
      <span className="btn-secondary cursor-progress" aria-live="polite">
        <Loader2 size={15} className="animate-spin" /> Uploading…
      </span>
    );
  }
  return (
    <div className="flex shrink-0 gap-1.5">
      <button type="button" onClick={onCamera} className="btn-secondary px-2.5 sm:hidden" aria-label="Take a photo" title="Take a photo">
        <Camera size={16} />
      </button>
      <button type="button" onClick={onLibrary} className="btn-secondary whitespace-nowrap">
        <ImagePlus size={15} /> {compact ? "Photos" : "Add photos"}
      </button>
    </div>
  );
}
