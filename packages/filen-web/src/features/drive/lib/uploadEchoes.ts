import { driveItemName, nameCollisionKey } from "@filen/shared"
import { queueListingCreate } from "@/features/drive/queries/drive"
import type { DriveItem } from "@/features/drive/lib/item"

// The socket echo of a file this tab is uploading usually arrives BEFORE the upload's own result: the server
// announces the file as it finalizes it, while the result still has to cross back from the SDK worker. Landed
// first, the echo mounts the row, whose tile starts generating its thumbnail from the drive — downloading the
// whole file — before the upload's result can seed it from the local File (landUpload). Each echo of a name an
// upload into that directory is sending is therefore held until that upload settles, then queued as it would
// have been; the upload's own result lands its row first. Held per directory and name rather than by uuid,
// which the SDK picks and only the result names.

interface HeldEcho {
	readonly parentUuid: string | null
	readonly item: DriveItem
	readonly recent: boolean
}

interface Hold {
	uploads: number
	readonly echoes: HeldEcho[]
}

const holds = new Map<string, Hold>()

// Names are compared as the drive keeps them apart (nameCollisionKey).
function holdKey(parentUuid: string | null, name: string): string {
	return `${parentUuid ?? ""}/${nameCollisionKey(name)}`
}

// Holds the echoes of `name` in `parentUuid` (normalized as the socket handler normalizes it: null for the root)
// until the returned release is called, once, after the upload settled either way.
export function holdUploadEchoes(parentUuid: string | null, name: string): () => void {
	const key = holdKey(parentUuid, name)
	const hold = holds.get(key) ?? { uploads: 0, echoes: [] }

	hold.uploads++
	holds.set(key, hold)

	let released = false

	return () => {
		if (released) {
			return
		}

		released = true
		hold.uploads--

		if (hold.uploads > 0) {
			return
		}

		holds.delete(key)

		for (const echo of hold.echoes) {
			queueListingCreate(echo.parentUuid, echo.item, { recent: echo.recent })
		}
	}
}

// Whether the echo of a new file was held for an upload of its name still under way.
export function holdUploadEcho(parentUuid: string | null, item: DriveItem, recent: boolean): boolean {
	const hold = holds.get(holdKey(parentUuid, driveItemName(item)))

	if (hold === undefined) {
		return false
	}

	hold.echoes.push({ parentUuid, item, recent })

	return true
}
