import { type TFunction } from "i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import { type DriveItem } from "@/types"
import { type UseDirectorySizeQueryParams } from "@/features/drive/queries/useDirectorySize.query"
import cache from "@/lib/cache"
import { driveItemDisplayName } from "@/lib/decryption"

type IoniconName = React.ComponentProps<typeof Ionicons>["name"]

// Empty-state icon per drive variant. Variants without a bespoke icon
// (drive / photos / linked) fall back to the generic open-folder glyph —
// matching the original chained-ternary default.
export const DRIVE_EMPTY_STATE_ICON: Record<DrivePathType, IoniconName> = {
	trash: "trash-outline",
	favorites: "heart-outline",
	recents: "time-outline",
	sharedIn: "people-outline",
	sharedOut: "people-outline",
	links: "link-outline",
	offline: "cloud-offline-outline",
	drive: "folder-open-outline",
	photos: "folder-open-outline",
	linked: "folder-open-outline"
}

type DriveEmptyStateTitleKey =
	| "trash_is_empty"
	| "no_favorites"
	| "no_recents"
	| "no_shared_in_items"
	| "no_shared_out_items"
	| "no_links"
	| "no_offline_items"
	| "folder_is_empty"

// Empty-state title key per drive variant. The original used `t(...)` inline in
// two chained ternaries; the lookup table keeps those keys in one place while the
// caller still resolves the translation.
export const DRIVE_EMPTY_STATE_TITLE_KEY: Record<DrivePathType, DriveEmptyStateTitleKey> = {
	trash: "trash_is_empty",
	favorites: "no_favorites",
	recents: "no_recents",
	sharedIn: "no_shared_in_items",
	sharedOut: "no_shared_out_items",
	links: "no_links",
	offline: "no_offline_items",
	drive: "folder_is_empty",
	photos: "folder_is_empty",
	linked: "folder_is_empty"
}

/**
 * Merge a directory listing with global search results, de-duplicating by uuid.
 * The local listing copy is preferred (it carries authoritative decryptedMeta /
 * favorite / offline state); a global search hit is added only when its uuid is
 * not already present in the local listing.
 */
export function mergeByUuid(local: DriveItem[], globalSearch: DriveItem[]): DriveItem[] {
	const byUuid = new Map<string, DriveItem>()

	for (const item of local) {
		byUuid.set(item.data.uuid, item)
	}

	for (const item of globalSearch) {
		if (!byUuid.has(item.data.uuid)) {
			byUuid.set(item.data.uuid, item)
		}
	}

	return Array.from(byUuid.values())
}

// Narrows a (sorted) DriveItem list to the subset matching the active search
// query. An empty/whitespace query returns the list unchanged. Matching is
// case-insensitive against `driveItemDisplayName`, which yields the
// `cannot_decrypt_<uuid>` placeholder for undecryptable items so they stay
// searchable via that text. Pure (no React/store reads) so both the list body
// and the header can derive the SAME visible set from one source — otherwise
// select-all / deselect-all would operate on search-hidden items.
export function filterDriveItemsBySearchQuery<T extends DriveItem>(items: T[], searchQuery: string): T[] {
	const normalized = searchQuery.trim().toLowerCase()

	if (normalized.length === 0) {
		return items
	}

	return items.filter(item => driveItemDisplayName(item).toLowerCase().includes(normalized))
}

export function getDriveEmptyStateIcon(type: DrivePathType | null): IoniconName {
	if (type === null) {
		return DRIVE_EMPTY_STATE_ICON.drive
	}

	return DRIVE_EMPTY_STATE_ICON[type]
}

export function getDriveEmptyStateTitleKey(type: DrivePathType | null): DriveEmptyStateTitleKey {
	if (type === null) {
		return DRIVE_EMPTY_STATE_TITLE_KEY.drive
	}

	return DRIVE_EMPTY_STATE_TITLE_KEY[type]
}

type DriveEmptyStateDescriptionKey =
	| "trash_is_empty_description"
	| "no_favorites_description"
	| "no_recents_description"
	| "no_shared_in_items_description"
	| "no_shared_out_items_description"
	| "no_links_description"
	| "no_offline_items_description"
	| "folder_is_empty_description"

// Empty-state subtitle key per drive variant — mirrors DRIVE_EMPTY_STATE_TITLE_KEY
// so the ListEmpty under each Drive variant gets a fitting one-line description.
export const DRIVE_EMPTY_STATE_DESCRIPTION_KEY: Record<DrivePathType, DriveEmptyStateDescriptionKey> = {
	trash: "trash_is_empty_description",
	favorites: "no_favorites_description",
	recents: "no_recents_description",
	sharedIn: "no_shared_in_items_description",
	sharedOut: "no_shared_out_items_description",
	links: "no_links_description",
	offline: "no_offline_items_description",
	drive: "folder_is_empty_description",
	photos: "folder_is_empty_description",
	linked: "folder_is_empty_description"
}

export function getDriveEmptyStateDescriptionKey(type: DrivePathType | null): DriveEmptyStateDescriptionKey {
	if (type === null) {
		return DRIVE_EMPTY_STATE_DESCRIPTION_KEY.drive
	}

	return DRIVE_EMPTY_STATE_DESCRIPTION_KEY[type]
}

/**
 * Resolves the breadcrumb/header title for a Drive screen. Mirrors the original
 * inline derivation:
 *   - bulk-selection (non-picker) → "N selected"
 *   - picker (`selectOptions`)    → destination / select-item(s) phrasing
 *   - otherwise                   → cached decrypted directory name, falling
 *     back to the undecryptable placeholder, then the localized variant default.
 */
export function resolveDriveHeaderTitle({
	drivePath,
	selectedCount,
	stringifiedClientRootUuid,
	t
}: {
	drivePath: DrivePath
	selectedCount: number
	stringifiedClientRootUuid: string | null
	t: TFunction
}): string {
	// In bulk-selection mode, swap the directory name out for the count —
	// matches Notes / Tracks / Contacts / Participants / Versions.
	// Picker mode (drivePath.selectOptions) keeps its own destination title.
	if (selectedCount > 0 && !drivePath.selectOptions) {
		return t("selected", { count: selectedCount })
	}

	if (drivePath.selectOptions) {
		switch (drivePath.selectOptions.intention) {
			case "move": {
				return t("select_destination")
			}

			case "select": {
				return drivePath.selectOptions.directories && drivePath.selectOptions.files
					? drivePath.selectOptions.type === "single"
						? t("select_item")
						: t("select_items")
					: drivePath.selectOptions.directories
						? drivePath.selectOptions.type === "single"
							? t("select_directory")
							: t("select_directories")
						: drivePath.selectOptions.type === "single"
							? t("select_file")
							: t("select_files")
			}
		}
	}

	// Resolve the breadcrumb title for the current directory. Prefers the
	// cached decrypted name; falls back to the cached DriveItem's display
	// name (which yields `cannot_decrypt_<uuid>` for undecryptable
	// directories) before the localized default.
	const resolveBreadcrumb = (fallback: string): string => {
		const uuid = drivePath.uuid ?? ""
		const cachedName = cache.directoryUuidToName.get(uuid)

		if (cachedName) {
			return cachedName
		}

		const cachedItem = cache.uuidToAnyDriveItem.get(uuid)

		if (cachedItem && cachedItem.data.undecryptable) {
			return driveItemDisplayName(cachedItem)
		}

		return fallback
	}

	switch (drivePath.type) {
		case "drive": {
			if (stringifiedClientRootUuid && (drivePath.uuid ?? "") === stringifiedClientRootUuid) {
				return t("drive")
			}

			return resolveBreadcrumb(t("drive"))
		}

		case "offline": {
			return resolveBreadcrumb(t("offline"))
		}

		case "sharedIn": {
			return resolveBreadcrumb(t("shared_with_me"))
		}

		case "sharedOut": {
			return resolveBreadcrumb(t("shared_with_others"))
		}

		case "links": {
			return resolveBreadcrumb(t("links"))
		}

		case "favorites": {
			return resolveBreadcrumb(t("favorites"))
		}

		case "linked": {
			if (drivePath.linked && drivePath.linked.rootName) {
				return drivePath.linked.rootName
			}

			return resolveBreadcrumb(t("linked"))
		}

		case "trash": {
			return t("trash")
		}

		case "recents": {
			return t("recents")
		}

		default: {
			return ""
		}
	}
}

// The raw "uploaded" timestamp, normalized across the DriveItem shapes used by the
// item-info rows: shared (non-root + root) directories carry it under `data.inner`,
// every other shape carries it directly under `data`. Returned as a number for
// `simpleDate`. Mirrors the per-type access the info rows did inline before.
export function rawUploadTimestamp(item: DriveItem): number {
	return item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
		? Number(item.data.inner.timestamp)
		: Number(item.data.timestamp)
}

// Picks the timestamp to display for a created/modified row: the decrypted-meta
// value when present, else the raw upload timestamp. Preserves the original
// truthiness fallback (a 0 / 0n / missing meta value falls back to the upload
// time) — see the "falsy bigint" caveat in the test infra notes.
export function pickDisplayTimestamp(metaValue: bigint | number | null | undefined, fallbackTimestamp: number): number {
	return metaValue ? Number(metaValue) : fallbackTimestamp
}

// Maps the drive context (variant) to the directory-size query mode. The sharing
// role (sharedIn vs sharedOut) and trash/offline/linked computation can't be
// derived from a DriveItem's type alone — they come from the screen we're on —
// so the item-info size query keys off the active DrivePath instead. Everything
// not covered (drive / recents / favorites / links / photos / null) is a regular
// remote directory → "normal".
export function directorySizeTypeForDrivePath(type: DrivePathType | null | undefined): UseDirectorySizeQueryParams["type"] {
	switch (type) {
		case "sharedIn": {
			return "sharedIn"
		}

		case "sharedOut": {
			return "sharedOut"
		}

		case "trash": {
			return "trash"
		}

		case "offline": {
			return "offline"
		}

		case "linked": {
			return "linked"
		}

		default: {
			return "normal"
		}
	}
}
