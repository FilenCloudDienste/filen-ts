import type { ParentUuid, UuidStr } from "@filen/sdk-rs"

// The non-uuid arms of ParentUuid: the flat pseudo-parent listings. Import-free at runtime so the
// SDK worker can derive its sentinel set from it.
export const FLAT_LISTING_KINDS = ["recents", "favorites", "trash", "links"] as const satisfies readonly Exclude<ParentUuid, UuidStr>[]

export type FlatListingKind = (typeof FLAT_LISTING_KINDS)[number]
