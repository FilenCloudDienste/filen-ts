// Extra fields every DriveItem carries beyond its raw wasm shape (mirrors filen-mobile's
// ExtraData): `size` is synthetic for directories (Dir has no native size field — sort.ts's bigint
// size compare needs one so dirs group uniformly against files), `uuid` restates the item's own
// uuid at the union's shared shape, and `undecryptable` mirrors `decryptedMeta`'s nullness so a
// consumer can branch on a plain boolean instead of a null check.
export interface ExtraData {
	size: bigint
	uuid: string
	undecryptable: boolean
}

// The minimal structural shape driveItemName needs — matches both apps' hand-built DriveItem
// without importing either app's DriveItem type or any generated SDK type.
export interface DriveItemLike {
	data: {
		uuid: string
		decryptedMeta?: { name: string } | null
	}
}

// A drive item's display name: the decrypted metadata's name if available, else the item's own
// uuid. Callers that need to show a placeholder for an undecryptable item apply that branch on top
// (see filen-mobile's driveItemDisplayName) — this is only the shared `name ?? uuid` core.
export function driveItemName(item: DriveItemLike): string {
	return item.data.decryptedMeta?.name ?? item.data.uuid
}
