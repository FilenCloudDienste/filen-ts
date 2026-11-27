import { nameCollisionKey } from "@filen/shared"
import { accountQueryGet } from "@/queries/account"
import { normalizeParentUuid } from "@/features/drive/queries/drive"

// The names uploads of this tab are about to create, per directory, from the moment their conflict check passed
// until they settled: what no listing holds yet (a file still sending, a directory a run has not created, a file
// waiting on its parent) but a check made meanwhile must see. A check reads the listing, then these and claims its
// own names in the same synchronous step, so two uploads started together never both take a name.

export type HeldKind = "file" | "directory"

interface Claim {
	readonly kind: HeldKind
	count: number
}

const claims = new Map<string | null, Map<string, Claim>>()

// The root by null, however a caller names it.
export function claimParent(parentUuid: string | null): string | null {
	return normalizeParentUuid(parentUuid, accountQueryGet()?.rootDirUuid ?? "")
}

// Claims `name` in `parentUuid` until the returned release is called (once; later calls do nothing).
export function claimUploadName(parentUuid: string | null, name: string, kind: HeldKind): () => void {
	const parent = claimParent(parentUuid)
	const key = nameCollisionKey(name)
	let byName = claims.get(parent)

	if (byName === undefined) {
		byName = new Map()

		claims.set(parent, byName)
	}

	const claim = byName.get(key) ?? { kind, count: 0 }

	claim.count++
	byName.set(key, claim)

	let released = false

	return () => {
		if (released) {
			return
		}

		released = true
		claim.count--

		if (claim.count > 0 || byName.get(key) !== claim) {
			return
		}

		byName.delete(key)

		if (byName.size === 0 && claims.get(parent) === byName) {
			claims.delete(parent)
		}
	}
}

// Every name claimed in `parentUuid`, by collision key.
export function claimedUploadNames(parentUuid: string | null): ReadonlyMap<string, { readonly kind: HeldKind }> | undefined {
	return claims.get(claimParent(parentUuid))
}

// Logout: claims belong to the ended session's uploads.
export function discardUploadClaims(): void {
	claims.clear()
}
