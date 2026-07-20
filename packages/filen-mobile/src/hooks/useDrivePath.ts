import { useLocalSearchParams, useNavigation } from "expo-router"
import { validateUuid } from "@/lib/uuid"
import type { DriveItem, DriveItemDirectorySharedRoot, DriveItemDirectorySharedNonRoot } from "@/types"
import { deserialize, deserializeRouteParam } from "@/lib/serializer"
import { useCameraUpload } from "@/features/cameraUpload/cameraUpload"
import type { PreviewType } from "@/lib/previewType"
import type { SharingRole } from "@filen/sdk-rs"

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

// Validates a raw route-param string against the known drive variants. Used by
// the modal screens (item-info / change-color) that receive the originating
// variant as a serialized string param so they can resolve context-dependent
// queries (e.g. directory size) the same way the originating list did.
export function isDrivePathType(value: string | null | undefined): value is DrivePathType {
	return value != null && (DRIVE_PATH_TYPES as readonly string[]).includes(value)
}

export type SelectOptions = {
	type: "single" | "multiple"
	files: boolean
	directories: boolean
	intention: "move" | "select"
	items: DriveItem[]
	// Rows the picker opens with already ticked — the caller's current value (e.g. the
	// configured camera-upload directory). Pure selection-store seeding; unlike `items`
	// (which DISABLES rows in select intent), these stay fully interactive.
	initiallySelected?: DriveItem[]
	previewType?: PreviewType
	id: string
}

export type Linked = {
	uuid: string
	key: string
	rootName: string
	password?: string
}

// SDK share context for the tapped directory, threaded through the destination screen's nav params.
// A plain tagged payload (never an SDK wrapper instance) so it survives the route-param serializer;
// the destination re-derives the SDK share handle from it. Without it, a fresh session with a cold
// in-memory cache cannot resolve a shared subdirectory.
export type SharedNavContext =
	| {
			kind: "root"
			dir: DriveItemDirectorySharedRoot
	  }
	| {
			kind: "dir"
			dir: DriveItemDirectorySharedNonRoot
			role: SharingRole
	  }

export type DrivePath =
	| {
			type: DrivePathType
			uuid: string | null
			selectOptions?: SelectOptions
			linked?: Linked
			shared?: SharedNavContext
	  }
	| {
			type: null
			uuid: null
			selectOptions?: SelectOptions
			linked?: Linked
			shared?: SharedNavContext
	  }

export default function useDrivePath(): DrivePath {
	const searchParams = useLocalSearchParams<{
		uuid?: string
		selectOptions?: string
		linked?: string
		shared?: string
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
					initiallySelected: parsed.initiallySelected,
					id: parsed.id,
					previewType: parsed.previewType
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

	// The sharedIn/sharedOut destination screens carry the tapped directory's SDK share context here;
	// garbage/absent parses to null (deserializeRouteParam swallows its own error).
	const shared = deserializeRouteParam<SharedNavContext>(searchParams?.shared)

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
					: uuid,
				// Only the shared variants carry a share context; other variants resolve by uuid alone.
				...((isSharedInScreen || isSharedOutScreen) && shared ? { shared } : {})
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
