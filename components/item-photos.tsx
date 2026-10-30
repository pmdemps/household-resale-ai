import { ImageIcon, Star, X } from "lucide-react";
import { deleteItemPhoto, makeCoverPhoto } from "@/app/photo-actions";
import { PhotoUploader } from "@/components/photo-uploader";
import { MAX_PHOTOS_PER_ITEM } from "@/lib/photo-url";
import type { ItemPhoto } from "@/lib/types";

type PhotoRow = ItemPhoto & { url: string };

/* Plain <img>: photos come from the public Supabase bucket (or a data URL in previews), so next/image
   would need remotePatterns and still couldn't optimise HEIC. */
export function Photo({ src, alt, className }: { src: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading="lazy" decoding="async" />;
}

/** 56px square thumbnail for list rows; a soft placeholder when the item has no photo yet. */
export function ItemThumb({ src, alt }: { src?: string; alt: string }) {
  if (!src) {
    return (
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-slate-600" aria-hidden>
        <ImageIcon size={20} />
      </span>
    );
  }
  return <Photo src={src} alt={alt} className="h-14 w-14 shrink-0 rounded-xl bg-ink object-cover" />;
}

/** The Photos section on an item page: big cover, thumbnail strip with delete / make-cover, and the uploader. */
export function ItemPhotos({ itemId, itemName, photos }: { itemId: string; itemName: string; photos: PhotoRow[] }) {
  const cover = photos[0];
  return (
    <section className="surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">Photos</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {photos.length === 0 ? `Up to ${MAX_PHOTOS_PER_ITEM}. The first is the cover.` : `${photos.length} of ${MAX_PHOTOS_PER_ITEM} · the cover goes on every listing`}
          </p>
        </div>
        {photos.length < MAX_PHOTOS_PER_ITEM && <PhotoUploader itemId={itemId} compact={photos.length > 0} />}
      </div>

      {!cover ? (
        <div className="mt-4 rounded-xl border border-dashed border-line px-4 py-7 text-center">
          <ImageIcon size={26} className="mx-auto text-slate-500" aria-hidden />
          <p className="mt-2 text-sm text-slate-400">No photos yet. Add a couple — listings with photos sell faster.</p>
        </div>
      ) : (
        <>
          <figure className="relative mt-4 overflow-hidden rounded-2xl bg-ink">
            <Photo src={cover.url} alt={`${itemName} (cover photo)`} className="aspect-[4/3] w-full object-cover" />
            <figcaption className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-on-accent">
              <Star size={11} fill="currentColor" /> Cover
            </figcaption>
          </figure>
          <ul className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="All photos">
            {photos.map((p, i) => (
              <li key={p.id} className="w-[88px] shrink-0">
                <div className={"overflow-hidden rounded-xl bg-ink " + (i === 0 ? "ring-2 ring-accent" : "ring-1 ring-line")}>
                  <Photo src={p.url} alt={`${itemName}, photo ${i + 1}`} className="h-[88px] w-[88px] object-cover" />
                </div>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  <form action={makeCoverPhoto}>
                    <input type="hidden" name="id" value={p.id} />
                    <button
                      className={"flex h-7 w-full items-center justify-center rounded-lg " + (i === 0 ? "text-link" : "text-slate-500 hover:bg-white/[0.06] hover:text-white")}
                      aria-label={i === 0 ? "This is the cover photo" : `Make photo ${i + 1} the cover`}
                      title={i === 0 ? "Cover photo" : "Make cover"}
                      disabled={i === 0}
                    >
                      <Star size={15} fill={i === 0 ? "currentColor" : "none"} />
                    </button>
                  </form>
                  <form action={deleteItemPhoto}>
                    <input type="hidden" name="id" value={p.id} />
                    <button className="flex h-7 w-full items-center justify-center rounded-lg text-slate-500 hover:bg-white/[0.06] hover:text-bad" aria-label={`Delete photo ${i + 1}`} title="Delete">
                      <X size={15} />
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
