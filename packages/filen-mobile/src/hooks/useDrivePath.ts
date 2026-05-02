import { useLocalSearchParams, useNavigation } from "expo-router"
import { validate as validateUuid } from "uuid"
import type { DriveItem } from "@/types"
import { deserialize } from "@/lib/serializer"
import { useCameraUpload } from "@/lib/cameraUpload"

export const DRIVE_PATH_TYPES = [
	"drive",
	"sharedIn",
	"recents",
	"favorites",
	"trash",
	"sharedOut",
	"offline",
	"links",
	"photos",
	"linked"
] as const
export type DrivePathType = (typeof DRIVE_PATH_TYPES)[number]

export type SelectOptions = {
	type: "single" | "multiple"
	files: boolean
	directories: boolean
	intention: "move" | "select"
	items: DriveItem[]
	id: string
}

export type Linked = {
	uuid: string
	key: string
	rootName: string
	password?: string
}

export type DrivePath =
	| {
			type: DrivePathType
			uuid: string | null
			selectOptions?: SelectOptions
			linked?: Linked
	  }
	| {
			type: null
			uuid: null
			selectOptions?: SelectOptions
			linked?: Linked
	  }

export default function useDrivePath(): DrivePath {
	const searchParams = useLocalSearchParams<{
		uuid?: string
		selectOptions?: string
		linked?: string
	}>()
	const { getId: getNavigationId } = useNavigation()
	const { config: cameraUploadConfig } = useCameraUpload()

	const selectOptions = ((): SelectOptions | null => {
		if (searchParams && searchParams.selectOptions) {
			try {
				const parsed = deserialize(searchParams.selectOptions) as SelectOptions

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
	})()

	const linked = ((): Linked | null => {
		if (searchParams && searchParams.linked) {
			try {
				const parsed = deserialize(searchParams.linked) as Linked

				return parsed
			} catch {
				return null
			}
		}

		return null
	})()

	const drivePath = ((): DrivePath => {
		const navigationId = getNavigationId() ?? ""
		const isDriveSelectScreen = navigationId.startsWith("/driveSelect")
		const uuid =
			searchParams && searchParams.uuid && searchParams.uuid.length > 0 && validateUuid(searchParams.uuid) ? searchParams.uuid : null

		if (isDriveSelectScreen && selectOptions) {
			return {
				type: "drive",
				uuid,
				selectOptions
			}
		}

		const isLinkedDirScreen = navigationId.startsWith("/linkedDir")

		if (isLinkedDirScreen && linked) {
			return {
				type: "linked",
				uuid,
				linked
			} satisfies DrivePath
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
				uuid: isPhotosScreen
					? cameraUploadConfig.enabled && cameraUploadConfig.remoteDir
						? cameraUploadConfig.remoteDir.inner[0].uuid
						: null
					: uuid
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
	})()

	return drivePath
}
