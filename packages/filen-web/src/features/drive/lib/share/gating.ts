import { type DriveVariant } from "@/features/drive/lib/preferences"

// Variants whose items the user OWNS and can therefore share with a contact: My Drive and its derived
// owned views (recents/favorites), the shared-with-others surface (re-sharing an already shared-out
// item to another recipient), and links (a cross-tree aggregation of the user's OWN items that happen
// to carry a public link — same ownership as My Drive, mobile parity). Excluded: trash (disposed
// items), sharedIn (items owned by someone else — you can't grant access you don't have), and —
// enforced separately by the menu builders' own undecryptable short-circuit, not here — undecryptable
// items.
export function canShareVariant(variant: DriveVariant): boolean {
	return variant === "drive" || variant === "recents" || variant === "favorites" || variant === "sharedOut" || variant === "links"
}

// The one shared surface the caller does NOT own: sharedIn lists items someone else shared TO them,
// so every owner-mutating action (rename/move/trash/color/versions/favorite/publicLink/copyLink) is
// gated off it in the item/bulk-action builders — the SDK rejects a mutation against an item you
// don't own. sharedOut is deliberately excluded here: those items are the caller's OWN, merely shared
// OUT to someone else, so the full owner toolbar applies there exactly as it would in My Drive (see
// the item/bulk-action builders' own `ownerMutable = !isReadOnlySharedVariant(variant)` gate). Only
// IMPORT (copying a not-owned item into your own drive) and the sharing-scoped SHARE/UNSHARE
// distinguish the two surfaces beyond this.
export function isReadOnlySharedVariant(variant: DriveVariant): boolean {
	return variant === "sharedIn"
}
