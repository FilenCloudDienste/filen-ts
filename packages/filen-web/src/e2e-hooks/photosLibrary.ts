import { sdkApi } from "@/lib/sdk/client"
import { loadPhotosLibrary, photosLibraryView, removePhotosRoot } from "@/features/photos/lib/library"
import { isScratchDebrisName } from "@/e2e-hooks/scratchDebris"

// cleanup.setup.ts: a Photos run killed before its own removal leaves its root in `.filen/photos`, and every later
// run expects the unset screen. A root goes when it or its parent is gone or trashed (a fixture tree's directory
// sits one level down, and the fixture teardown trashes the tree), or when either is scratch-named and older than
// `minAgeMs`. Removed through the app's own edit, each resolving once uploaded. Returns the count.
export async function pruneLeftoverPhotosRoots(minAgeMs: number): Promise<number> {
	await loadPhotosLibrary()

	const cutoff = Date.now() - minAgeMs
	let removed = 0

	for (const uuid of photosLibraryView().roots ?? []) {
		const dir = await sdkApi.getDirectory(uuid)

		if (dir === undefined || dir.parent === "trash") {
			await removePhotosRoot(uuid)
			removed++

			continue
		}

		// Undefined for the drive root, a scratch directory's parent.
		const parent = await sdkApi.getDirectory(dir.parent)
		const leftover =
			parent?.parent === "trash" ||
			[dir, parent].some(d => d?.meta.type === "decoded" && isScratchDebrisName(d.meta.data.name) && Number(d.timestamp) <= cutoff)

		if (leftover) {
			await removePhotosRoot(uuid)
			removed++
		}
	}

	return removed
}
