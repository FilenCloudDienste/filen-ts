import { useLocalSearchParams, useNavigation } from "expo-router"
import { useMemo } from "@/lib/memo"
import { validate as validateUuid } from "uuid"

export const DRIVE_PATH_TYPES = ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links"] as const

export type DrivePathType = (typeof DRIVE_PATH_TYPES)[number]

export type DrivePath =
	| {
			type: DrivePathType
			uuid: string | null
	  }
	| {
			type: null
			uuid: null
	  }

export default function useDrivePath(): DrivePath {
	const localSearchParams = useLocalSearchParams<{
		uuid?: string
	}>()
	const navigation = useNavigation()

	const drivePath = useMemo((): DrivePath => {
		const navigationId = navigation.getId() || ""
		const isInDriveTab = navigationId.startsWith("/tabs/drive")
		const isInOfflineTab = navigationId.startsWith("/offline")
		const isTrashTab = navigationId.startsWith("/trash")
		const isFavoritesTab = navigationId.startsWith("/favorites")
		const isRecentsTab = navigationId.startsWith("/recents")
		const isLinksTab = navigationId.startsWith("/links")
		const isSharedInTab = navigationId.startsWith("/sharedIn")
		const isSharedOutTab = navigationId.startsWith("/sharedOut")

		if (isInDriveTab || isInOfflineTab || isLinksTab || isSharedInTab || isSharedOutTab || isFavoritesTab) {
			const type = isInDriveTab
				? "drive"
				: isInOfflineTab
					? "offline"
					: isSharedInTab
						? "sharedIn"
						: isSharedOutTab
							? "sharedOut"
							: isFavoritesTab
								? "favorites"
								: "links"

			if (localSearchParams && localSearchParams.uuid && validateUuid(localSearchParams.uuid)) {
				return {
					type,
					uuid: localSearchParams.uuid
				}
			}

			return {
				type,
				uuid: null
			}
		} else if (isTrashTab) {
			return {
				type: "trash",
				uuid: null
			}
		} else if (isRecentsTab) {
			return {
				type: "recents",
				uuid: null
			}
		}

		return {
			type: null,
			uuid: null
		}
	}, [localSearchParams, navigation])

	return drivePath
}
