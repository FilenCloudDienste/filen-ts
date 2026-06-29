import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import useDriveItemStoredOfflineQuery from "@/features/drive/queries/useDriveItemStoredOffline.query"
import useOfflineStore from "@/features/offline/store/useOffline.store"

export default function useDriveItemIndicators({
	item,
	drivePath
}: {
	item: DriveItem
	drivePath: DrivePath
}): {
	showFavorited: boolean
	showOffline: boolean
	isStoredOffline: boolean
	hasSyncError: boolean
} {
	const driveItemStoredOfflineQuery = useDriveItemStoredOfflineQuery({
		uuid: item.data.uuid,
		type: item.type
	})

	// Offline listing only: whether the last sync pass recorded an error for this item —
	// either directly (itemUuid) or for anything nested inside it (topLevelUuid). Surfaced
	// as a textual indicator line (rows already carry a file/dir icon, so no second icon).
	const hasSyncError = useOfflineStore(
		state =>
			drivePath.type === "offline" &&
			state.syncErrors.some(e => e.itemUuid === item.data.uuid || e.topLevelUuid === item.data.uuid)
	)

	const isStoredOffline = driveItemStoredOfflineQuery.data === true

	// Note: the original code checks `driveItemStoredOfflineQuery.status === "success" &&
	// driveItemStoredOfflineQuery.data` for the indicator — this is semantically equivalent
	// because when status is not "success", data is undefined and `undefined === true` is false.
	const showOffline = isStoredOffline && drivePath.type !== "offline"

	// Note: the original code also type-guards on `item.type === "file" || item.type === "directory"`.
	// That guard is necessary because sharedFile/sharedDirectory items do not carry a `favorited` field
	// in the discriminated union. We preserve it here to match the actual JSX condition verbatim.
	const showFavorited =
		(item.type === "file" || item.type === "directory") &&
		item.data.favorited === true &&
		drivePath.type !== "favorites"

	return {
		showFavorited,
		showOffline,
		isStoredOffline,
		hasSyncError
	}
}
