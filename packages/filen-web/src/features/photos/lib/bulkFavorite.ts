import { driveActivity, favoriteKeys } from "@/features/drive/lib/activity"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { runBulkActivity } from "@/lib/activity/activity"
import { setFavoritedPhotos } from "@/features/photos/lib/actions"
import { prunePhotoSelection } from "@/features/photos/store/usePhotosStore"
import type { PhotoItem } from "@/features/photos/lib/captureSort"

// The bulk favorite SET over a photos selection, as one activity: the selection bar's Favorite and the
// photos.toggleFavorite key both run this, so the two can never drift (drive's runBulkFavorite is its twin).
export async function runPhotosBulkFavorite(rootUuids: readonly string[], items: PhotoItem[]): Promise<void> {
	const favorited = !aggregateDriveSelectionFlags(items).includesFavorited

	await runBulkActivity(
		driveActivity(
			items,
			favoriteKeys(favorited),
			(targets, onSettled) => setFavoritedPhotos(rootUuids, targets, favorited, onSettled),
			{
				prune: prunePhotoSelection
			}
		)
	)
}
