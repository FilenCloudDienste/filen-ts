import { useLocalSearchParams, useNavigation } from "expo-router"
import { useMemo } from "@/lib/memo"
import { validate as validateUuid } from "uuid"
import type { DriveItem } from "@/types"
import { Buffer } from "react-native-quick-crypto"
import { unpack } from "@/lib/msgpack"

export const DRIVE_PATH_TYPES = ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links", "photos"] as const
export type DrivePathType = (typeof DRIVE_PATH_TYPES)[number]

export type SelectOptions = {
	type: "single" | "multiple"
	files: boolean
	directories: boolean
	intention: "move" | "select"
	items: DriveItem[]
	id: string
}

export type DrivePath =
	| {
			type: DrivePathType
			uuid: string | null
			selectOptions?: SelectOptions
	  }
	| {
			type: null
			uuid: null
			selectOptions?: SelectOptions
	  }

export default function useDrivePath(): DrivePath {
	const searchParams = useLocalSearchParams<{
		uuid?: string
		selectOptions?: string
	}>()
	const navigation = useNavigation()

	const selectOptions = useMemo((): SelectOptions | null => {
		if (searchParams && searchParams.selectOptions) {
			try {
				const parsed = unpack(Buffer.from(searchParams.selectOptions, "base64")) as SelectOptions

				return {
					type: parsed.type,
					files: parsed.files,
					directories: parsed.directories,
					intention: parsed.intention,
					items: parsed.items,
					id: parsed.id
				}
			} catch {
				return null
			}
		}

		return null
	}, [searchParams])

	const drivePath = useMemo((): DrivePath => {
		const navigationId = navigation.getId() ?? ""
		const isDriveSelectScreen = navigationId.startsWith("/driveSelect")

		if (isDriveSelectScreen && selectOptions) {
			return {
				type: "drive",
				uuid: searchParams && searchParams.uuid && validateUuid(searchParams.uuid) ? searchParams.uuid : null,
				selectOptions
			}
		}

		const isDriveScreen = navigationId.startsWith("/tabs/drive")
		const isPhotosScreen = navigationId.startsWith("/tabs/photos")
		const isOfflineScreen = navigationId.startsWith("/offline")
		const isTrashScreen = navigationId.startsWith("/trash")
		const isFavoritesScreen = navigationId.startsWith("/favorites")
		const isRecentsScreen = navigationId.startsWith("/recents")
		const isLinksScreen = navigationId.startsWith("/links")
		const isSharedInScreen = navigationId.startsWith("/sharedIn")
		const isSharedOutScreen = navigationId.startsWith("/sharedOut")

		if (
			isDriveScreen ||
			isOfflineScreen ||
			isLinksScreen ||
			isSharedInScreen ||
			isSharedOutScreen ||
			isFavoritesScreen ||
			isPhotosScreen
		) {
			const type = isDriveScreen
				? "drive"
				: isOfflineScreen
					? "offline"
					: isSharedInScreen
						? "sharedIn"
						: isSharedOutScreen
							? "sharedOut"
							: isPhotosScreen
								? "photos"
								: isFavoritesScreen
									? "favorites"
									: "links"

			return {
				type,
				uuid: searchParams && searchParams.uuid && validateUuid(searchParams.uuid) ? searchParams.uuid : null
			}
		} else if (isTrashScreen) {
			return {
				type: "trash",
				uuid: null
			}
		} else if (isRecentsScreen) {
			return {
				type: "recents",
				uuid: null
			}
		}

		return {
			type: null,
			uuid: null
		}
	}, [searchParams, navigation, selectOptions])

	return drivePath
}
