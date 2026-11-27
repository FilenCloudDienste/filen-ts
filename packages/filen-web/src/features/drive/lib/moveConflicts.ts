import { driveItemName, nameCollisionKey } from "@filen/shared"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { cachedListing } from "@/features/drive/queries/drive"
import { claimParent } from "@/features/drive/lib/uploadClaims"
import { askNameConflicts } from "@/features/drive/lib/nameConflictAsk"
import {
	findNameConflicts,
	namesHeldIn,
	resolveNames,
	withClaims,
	type ConflictAnswer,
	type HeldNames,
	type NameConflict
} from "@/features/drive/lib/nameConflicts"

export interface ResolvedMove {
	// The items to move, those the user skipped left out.
	items: DriveItem[]
	// By uuid: the name an item moves under (Keep both).
	renames: Map<string, string>
}

export interface MoveConflictDeps {
	namesHeldIn: (parentUuid: string | null) => Promise<HeldNames | null>
	ask: (args: { operation: "move"; parentUuid: string | null; conflicts: readonly NameConflict[] }) => Promise<ConflictAnswer | null>
	// The names a directory's cached listing holds: never a request.
	cachedNames: (parentUuid: string | null) => readonly DriveItem[] | undefined
}

export const defaultMoveConflictDeps: MoveConflictDeps = {
	namesHeldIn,
	ask: askNameConflicts,
	cachedNames: parentUuid => cachedListing("drive", claimParent(parentUuid))
}

// A move's name conflicts in `destinationUuid`, checked against its listing (from the cache, read once when none is
// current) and asked about: a file onto a file may replace it (the server makes the moved file its new version), any
// clash may keep both (moved under the SDK's numbered name) or skip. Keep both renames the item where it is first, so
// its name must be free there too: checked against that directory's cached listing when there is one, the server's
// refusal (errors:NameTaken) covering the rest. Without a listing to check against, everything moves as before.
export async function resolveMoveConflicts(
	items: readonly DriveItem[],
	destinationUuid: string | null,
	deps: MoveConflictDeps = defaultMoveConflictDeps
): Promise<ResolvedMove> {
	const held = await deps.namesHeldIn(destinationUuid)

	if (held === null) {
		return { items: [...items], renames: new Map() }
	}

	const candidates = items.map(item => ({ name: driveItemName(item), isDirectory: isDirectoryItem(item), uuid: item.data.uuid }))
	const conflicts = findNameConflicts(candidates, withClaims(held, destinationUuid))

	if (conflicts.length === 0) {
		return { items: [...items], renames: new Map() }
	}

	const answer = await deps.ask({ operation: "move", parentUuid: destinationUuid, conflicts })
	const taken: HeldNames = new Map(held)
	const sources = new Set<string | null>()

	for (const { index } of conflicts) {
		const item = items[index]

		if (item !== undefined && item.data.parent !== "trash") {
			sources.add(claimParent(item.data.parent))
		}
	}

	for (const source of sources) {
		for (const row of deps.cachedNames(source) ?? []) {
			const key = nameCollisionKey(driveItemName(row))

			if (!taken.has(key)) {
				taken.set(key, { kind: isDirectoryItem(row) ? "directory" : "file", item: row })
			}
		}
	}

	const names = resolveNames({ candidates, held: taken, conflicts, answer })
	const moving: DriveItem[] = []
	const renames = new Map<string, string>()

	for (const [index, item] of items.entries()) {
		const name = names[index]

		if (name === undefined || name.action === "skip") {
			continue
		}

		if (name.action === "rename") {
			renames.set(item.data.uuid, name.name)
		}

		moving.push(item)
	}

	return { items: moving, renames }
}
