import { loadPhotosLibrary, photosLibraryView, removePhotosRoot } from "@/features/photos/lib/library"

// The photos specs start from the unset screen, so they first clear every root the account holds: whatever a
// killed or cut-short run left there (a fixture tree's directory, a scratch directory). The e2e account runs one
// write lane at a time, and the photos specs are in it, so no other spec holds a root meanwhile. Each removal is
// the app's own edit and resolves once uploaded. Returns the count.
export async function clearPhotosRoots(): Promise<number> {
	await loadPhotosLibrary()

	const roots = photosLibraryView().roots ?? []

	for (const uuid of roots) {
		await removePhotosRoot(uuid)
	}

	return roots.length
}
