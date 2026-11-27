import { compareNames } from "./naturalSort"

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

// The key two names in one directory collide on. The SDK stores names NFC-normalized and the server keeps
// them unique through a hash of that form lowercased with Rust's str::to_lowercase (sdk-rs hash_name), the
// full Unicode lowercase mapping with final sigma; String.prototype.toLowerCase is the same mapping, so "İ"
// folds to "i" plus a combining dot here too, never a plain "i". NFC first, so a decomposed name collides
// with its composed form.
export function nameCollisionKey(name: string): string {
	return name.normalize("NFC").toLowerCase()
}

// How the names of one directory relate: the key two names collide on, and the drive's natural name order. What the
// assistant's batch planner (assistant/batch.ts) is handed, as the assistant subpath cannot import it.
export const DRIVE_NAME_RULES = { key: nameCollisionKey, compare: compareNames } as const
