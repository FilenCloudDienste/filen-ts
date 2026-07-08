import { type DriveVariant } from "@/lib/drive/preferences"

// Variants whose items the user OWNS and can therefore share with a contact: My Drive and its derived
// owned views (recents/favorites), plus the shared-with-others surface (re-sharing an already
// shared-out item to another recipient). Excluded: trash (disposed items), sharedIn (items owned by
// someone else — you can't grant access you don't have), and — enforced separately by the menu
// builders' own undecryptable short-circuit, not here — undecryptable items. On web the single-item
// and bulk share menus gate identically: mobile's extra single-only variants (links/photos) have no
// web equivalent yet, so the two variant sets collapse to this one predicate.
export function canShareVariant(variant: DriveVariant): boolean {
	return variant === "drive" || variant === "recents" || variant === "favorites" || variant === "sharedOut"
}

// Either shared surface — sharedIn (owned by someone else) or sharedOut (owned by the caller but
// shared out). Gates every owner-mutating action (rename/move/trash/color/versions/favorite/
// publicLink/copyLink) off both in the item/bulk-action builders: on sharedIn the caller doesn't own
// the item (the SDK rejects the mutation); on sharedOut the mutation would succeed but its cache patch
// downgrades the shared row to a base arm (losing the "Shared with…" badge/Unshare until refetch) and
// move/link assume base arms — a safe-subset choice pending a dedicated fix, not this one. Only
// INFO (read-only) and the sharing-scoped SHARE/UNSHARE survive on these two surfaces.
export function isSharedVariant(variant: DriveVariant): boolean {
	return variant === "sharedIn" || variant === "sharedOut"
}
