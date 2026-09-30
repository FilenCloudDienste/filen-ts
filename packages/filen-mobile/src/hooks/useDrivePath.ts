import { useLocalSearchParams, useNavigation } from "expo-router"
import { validateUuid } from "@filen/shared"
import type { DriveItem, DriveItemDirectorySharedRoot, DriveItemDirectorySharedNonRoot } from "@/types"
import { deserializeRouteParam } from "@/lib/serializer"
import { getDriveSelectSession } from "@/features/drive/store/useDriveSelect.store"
import { useCameraUploadConfig } from "@/features/cameraUpload/cameraUpload"
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
	intention: "move" | "copy" | "select"
	// The session's source items (moved or copied, or excluded from a pick) — never in the route params,
	// read back from the picker session store by `id`.
	items: DriveItem[]
	itemUuids: ReadonlySet<string>
	// Rows the picker opens with already ticked — the caller's current value (e.g. the
	// configured camera-upload directory). Input only: it seeds the session's selection and is
	// never read back. Unlike `items` (which DISABLES rows in select intent), these stay fully interactive.
	initiallySelected?: DriveItem[]
	previewType?: PreviewType
	id: string
}

// What a picker screen's route param carries: everything but the session's items and preselection.
export type SelectOptionsParam = Omit<SelectOptions, "items" | "itemUuids" | "initiallySelected">

// No prefix here is a prefix of another, so the order never decides a match.
const ROUTE_PREFIX_TYPES: readonly (readonly [string, Exclude<DrivePathType, "linked">])[] = [
	["/tabs/drive", "drive"],
	["/offline", "offline"],
	["/sharedIn", "sharedIn"],
	["/sharedOut", "sharedOut"],
	["/tabs/photos", "photos"],
	["/favorites", "favorites"],
	["/links", "links"],
	["/trash", "trash"],
	["/recents", "recents"]
]

const NO_ITEMS: DriveItem[] = []
const NO_UUIDS: ReadonlySet<string> = new Set()

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
	// Read the params out as STRINGS up front. useLocalSearchParams() builds a fresh object on every
	// call (Object.fromEntries over the route params), so any derived value that reads `searchParams`
	// itself — the `searchParams &&` guard and the `searchParams?.shared` access below both do — gets
	// keyed on that new identity and recomputes every render. That made the returned DrivePath a new
	// object every render, which flows into the drive list's `renderItem` and defeats FlashList's per-cell
	// memo (its comparator checks `renderItem` by identity), re-rendering every visible row — each of
	// which rebuilds its whole context menu. Keying on the strings instead is behaviour-identical:
	// useLocalSearchParams never returns null/undefined (it falls back to `{}` internally), so the
	// object-truthiness guard could not have been false.
	const uuidParam = searchParams.uuid
	const selectOptionsParam = searchParams.selectOptions
	const linkedParam = searchParams.linked
	const sharedParam = searchParams.shared
	const { getId: getNavigationId } = useNavigation()
	const { config: cameraUploadConfig } = useCameraUploadConfig()

	// No try/catch and no hook referenced as a value in here: either makes the React Compiler skip this hook,
	// and the DrivePath it returns is then a new object every render (every row re-renders, the listing
	// re-sorts). deserializeRouteParam swallows a garbage param itself.
	const parsedSelectOptions = deserializeRouteParam<SelectOptionsParam>(selectOptionsParam)
	const selectSession = parsedSelectOptions ? getDriveSelectSession(parsedSelectOptions.id) : undefined
	const selectOptions: SelectOptions | null = parsedSelectOptions
		? {
				type: parsedSelectOptions.type,
				files: parsedSelectOptions.files,
				directories: parsedSelectOptions.directories,
				intention: parsedSelectOptions.intention,
				items: selectSession?.items ?? NO_ITEMS,
				itemUuids: selectSession?.itemUuids ?? NO_UUIDS,
				id: parsedSelectOptions.id,
				previewType: parsedSelectOptions.previewType
			}
		: null

	const linked = deserializeRouteParam<Linked>(linkedParam)

	// The sharedIn/sharedOut destination screens carry the tapped directory's SDK share context here;
	// garbage/absent parses to null (deserializeRouteParam swallows its own error).
	const shared = deserializeRouteParam<SharedNavContext>(sharedParam)

	const drivePath = ((): DrivePath => {
		const navigationId = getNavigationId() ?? ""
		const isDriveSelectScreen = navigationId.startsWith("/driveSelect")
		const uuid =
			uuidParam && uuidParam.length > 0 && validateUuid(uuidParam) ? uuidParam : null

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

		const type = ROUTE_PREFIX_TYPES.find(([prefix]) => navigationId.startsWith(prefix))?.[1]

		if (!type) {
			return {
				type: null,
				uuid: null
			}
		}

		if (type === "trash" || type === "recents") {
			return {
				type,
				uuid: null
			}
		}

		if (type === "photos") {
			return {
				type,
				uuid: cameraUploadConfig.enabled && cameraUploadConfig.remoteDir ? cameraUploadConfig.remoteDir.inner[0].uuid : null
			}
		}

		return {
			type,
			uuid,
			// Only the shared variants carry a share context; other variants resolve by uuid alone.
			...((type === "sharedIn" || type === "sharedOut") && shared ? { shared } : {})
		}
	})()

	return drivePath
}
