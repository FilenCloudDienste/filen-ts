import { onlineManager } from "@tanstack/react-query"
import { driveItemName, driveKeepBothName, nameCollisionKey } from "@filen/shared"
import { queryClient } from "@/queries/client"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { cachedListing, driveListingQueryOptions, flushListingCreates } from "@/features/drive/queries/drive"
import { claimParent, claimedUploadNames, type HeldKind } from "@/features/drive/lib/uploadClaims"

// Name conflicts of items written into a directory (uploads, moves): which names the directory holds, which of the
// items clash with them or with each other, and the names the user's choices give them. Names collide as the server
// keys them (nameCollisionKey); a trashed item holds no name (the server only checks live ones), as no listing shows one.

export type { HeldKind }

export interface HeldName {
	readonly kind: HeldKind
	// Absent for a name an upload still under way claims.
	readonly item?: DriveItem
}

// By collision key.
export type HeldNames = Map<string, HeldName>

// The names `parentUuid` holds, from its "drive" listing as the cache has it (unfiltered: hidden items hold names too)
// with the creates still queued for it landed: a listing current under the live socket answers without a request, any
// other is read once and kept as the app keeps every listing. Offline or unreadable, the cached rows however old; null
// when none are held, the caller then going on without a check. Claims are not in it: see withClaims.
export async function namesHeldIn(parentUuid: string | null): Promise<HeldNames | null> {
	const parent = claimParent(parentUuid)

	flushListingCreates()

	let items = cachedListing("drive", parent)

	if (onlineManager.isOnline()) {
		try {
			items = await queryClient.query(driveListingQueryOptions("drive", parent))
		} catch {
			items = cachedListing("drive", parent)
		}
	}

	return items === undefined ? null : heldNamesOf(items)
}

export function heldNamesOf(items: readonly DriveItem[]): HeldNames {
	const held: HeldNames = new Map()

	for (const item of items) {
		held.set(nameCollisionKey(driveItemName(item)), { kind: isDirectoryItem(item) ? "directory" : "file", item })
	}

	return held
}

// `held` with the names uploads of this tab claim in `parentUuid` added. Read in the same synchronous step that claims
// the caller's own names, after every await.
export function withClaims(held: HeldNames, parentUuid: string | null): HeldNames {
	const claimed = claimedUploadNames(parentUuid)

	if (claimed !== undefined) {
		for (const [key, claim] of claimed) {
			if (!held.has(key)) {
				held.set(key, { kind: claim.kind })
			}
		}
	}

	return held
}

export interface ConflictCandidate {
	name: string
	isDirectory: boolean
	// A moved item's own: the directory holding it already is no conflict.
	uuid?: string
}

export interface NameConflict {
	// Into the candidates.
	index: number
	name: string
	isDirectory: boolean
	existing: HeldKind
}

// The candidates whose names `held` holds, or an earlier candidate of the same batch takes.
export function findNameConflicts(candidates: readonly ConflictCandidate[], held: ReadonlyMap<string, HeldName>): NameConflict[] {
	const conflicts: NameConflict[] = []
	const batch = new Map<string, HeldKind>()

	for (const [index, candidate] of candidates.entries()) {
		const key = nameCollisionKey(candidate.name)
		const holder = held.get(key)
		const existing =
			holder !== undefined && (candidate.uuid === undefined || holder.item?.data.uuid !== candidate.uuid)
				? holder.kind
				: batch.get(key)

		if (existing !== undefined) {
			conflicts.push({ index, name: candidate.name, isDirectory: candidate.isDirectory, existing })
		} else {
			batch.set(key, candidate.isDirectory ? "directory" : "file")
		}
	}

	return conflicts
}

export type ConflictOperation = "upload" | "move"

// Replace: a file onto a file becomes its new version (an upload's finalize, and the server's move, both version it).
// Merge: an uploaded directory onto a directory (createDir returns the existing one). Neither exists for a directory
// moved onto anything (the SDK has no overwriting move) or a file onto a directory and back.
export type ConflictChoice = "replace" | "merge" | "keepBoth" | "skip"

// What a merge does with a file the directory it merges into already holds.
export type NestedPolicy = "replace" | "skip" | "keepBoth"

export interface ConflictAnswer {
	// One per conflict, in order.
	choices: ConflictChoice[]
	nested: NestedPolicy
}

export function primaryChoice(
	conflict: Pick<NameConflict, "isDirectory" | "existing">,
	operation: ConflictOperation
): "replace" | "merge" | undefined {
	if (!conflict.isDirectory && conflict.existing === "file") {
		return "replace"
	}

	return operation === "upload" && conflict.isDirectory && conflict.existing === "directory" ? "merge" : undefined
}

// `choice` made for one conflict applied to another: Replace and Merge stand for the conflict's own primary choice, and
// one it has none of keeps both.
export function choiceFor(
	conflict: Pick<NameConflict, "isDirectory" | "existing">,
	operation: ConflictOperation,
	choice: ConflictChoice
): ConflictChoice {
	if (choice !== "replace" && choice !== "merge") {
		return choice
	}

	return primaryChoice(conflict, operation) ?? "keepBoth"
}

export type ResolvedName =
	{ action: "keep"; name: string } | { action: "merge"; name: string } | { action: "rename"; name: string } | { action: "skip" }

// What each candidate becomes: its name kept (no conflict, or Replace), merged, renamed (Keep both, the SDK's naming
// free of every held name and every other candidate's) or skipped. Without an answer (a cancel) every conflict skips.
export function resolveNames({
	candidates,
	held,
	conflicts,
	answer
}: {
	candidates: readonly ConflictCandidate[]
	held: ReadonlyMap<string, HeldName>
	conflicts: readonly NameConflict[]
	answer: ConflictAnswer | null
}): ResolvedName[] {
	const choices = new Map<number, ConflictChoice>()

	for (const [position, conflict] of conflicts.entries()) {
		choices.set(conflict.index, answer?.choices[position] ?? "skip")
	}

	const taken = new Set(held.keys())

	for (const candidate of candidates) {
		taken.add(nameCollisionKey(candidate.name))
	}

	return candidates.map((candidate, index): ResolvedName => {
		switch (choices.get(index)) {
			case undefined:
			case "replace":
				return { action: "keep", name: candidate.name }
			case "merge":
				return { action: "merge", name: candidate.name }
			case "skip":
				return { action: "skip" }
			case "keepBoth": {
				const name = driveKeepBothName({ name: candidate.name, isDirectory: candidate.isDirectory, taken })

				taken.add(nameCollisionKey(name))

				return { action: "rename", name }
			}
		}
	})
}
