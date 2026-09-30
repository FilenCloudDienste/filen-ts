import { type TFunction } from "i18next"
import { type FetchStatus } from "@tanstack/react-query"
import { PasswordState, AnyLinkedDir, type DirPublicInfo, type DirPublicLink } from "@filen/sdk-rs"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import { type DriveItem } from "@/types"
import { type UseDirectorySizeQueryParams } from "@/features/drive/queries/useDirectorySize.query"
import cache from "@/lib/cache"
import { driveItemDisplayName } from "@/lib/decryption"

type IoniconName = React.ComponentProps<typeof Ionicons>["name"]

type DriveEmptyStateTitleKey =
	| "trash_is_empty"
	| "no_favorites"
	| "no_recents"
	| "no_shared_in_items"
	| "no_shared_out_items"
	| "no_links"
	| "no_offline_items"
	| "folder_is_empty"

type DriveEmptyState = {
	icon: IoniconName
	titleKey: DriveEmptyStateTitleKey
	descriptionKey: `${DriveEmptyStateTitleKey}_description`
}

function emptyState(icon: IoniconName, titleKey: DriveEmptyStateTitleKey): DriveEmptyState {
	return {
		icon,
		titleKey,
		descriptionKey: `${titleKey}_description`
	}
}

const FOLDER_EMPTY_STATE = emptyState("folder-open-outline", "folder_is_empty")

const DRIVE_EMPTY_STATE: Record<DrivePathType, DriveEmptyState> = {
	trash: emptyState("trash-outline", "trash_is_empty"),
	favorites: emptyState("heart-outline", "no_favorites"),
	recents: emptyState("time-outline", "no_recents"),
	sharedIn: emptyState("people-outline", "no_shared_in_items"),
	sharedOut: emptyState("people-outline", "no_shared_out_items"),
	links: emptyState("link-outline", "no_links"),
	offline: emptyState("cloud-offline-outline", "no_offline_items"),
	drive: FOLDER_EMPTY_STATE,
	photos: FOLDER_EMPTY_STATE,
	linked: FOLDER_EMPTY_STATE
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

export function getDriveEmptyState(type: DrivePathType | null): DriveEmptyState {
	return type === null ? FOLDER_EMPTY_STATE : DRIVE_EMPTY_STATE[type]
}

/**
 * Resolves the breadcrumb/header title for a Drive screen. Mirrors the original
 * inline derivation:
 *   - bulk-selection (non-picker) → "N selected"
 *   - picker (`selectOptions`)    → destination / select-item(s) phrasing
 *   - otherwise                   → the cached DriveItem's decrypted name, falling
 *     back to the undecryptable placeholder, then the localized variant default.
 *     Resolved from the single uuid→item cache.
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
	// Not read here. The name comes from the uuid cache, written outside React: a directory reached by uuid
	// alone (a search hit, "Open containing directory") is only cached during its listing's fetch. A compiled
	// caller keys this call on its inputs, so passing the fetch status resolves the title again when it settles.
	listingFetchStatus: FetchStatus
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
			case "move":
			case "copy": {
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

	// Resolve the breadcrumb title for the current directory from the single
	// uuid→item cache: prefers the item's decrypted name, falls back to its
	// display name (which yields `cannot_decrypt_<uuid>` for undecryptable
	// directories) before the localized default.
	const resolveBreadcrumb = (fallback: string): string => {
		const cachedItem = cache.uuidToAnyDriveItem.get(drivePath.uuid ?? "")

		const cachedName = cachedItem?.data.decryptedMeta?.name

		if (cachedName) {
			return cachedName
		}

		if (cachedItem?.data.undecryptable) {
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
const DIRECTORY_SIZE_TYPE: Partial<Record<DrivePathType, UseDirectorySizeQueryParams["type"]>> = {
	sharedIn: "sharedIn",
	sharedOut: "sharedOut",
	trash: "trash",
	offline: "offline",
	linked: "linked"
}

export function directorySizeTypeForDrivePath(type: DrivePathType | null | undefined): UseDirectorySizeQueryParams["type"] {
	return (type ? DIRECTORY_SIZE_TYPE[type] : undefined) ?? "normal"
}

// Display sanitizer for the custom directory-color hex field: strips everything but hex
// digits, folds casing, caps at 6 digits, and always re-applies the leading "#" so the
// prefix can't be deleted or duplicated.
export function sanitizeDirColorHexInput(text: string): string {
	return `#${text
		.replace(/[^0-9a-fA-F]/g, "")
		.toLowerCase()
		.slice(0, 6)}`
}

// Parses user/picker hex into the canonical cross-client form, or null when incomplete.
// Web/desktop validate custom colors against lowercase "#rrggbb" exactly and render
// anything else as the default color, so 3-digit shorthand is expanded and casing folded
// before a value ever leaves the screen.
export function normalizeCustomDirColorHex(text: string): string | null {
	const digits = text.trim().replace(/^#/, "").toLowerCase()

	if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(digits)) {
		return null
	}

	const expanded =
		digits.length === 3
			? digits
					.split("")
					.map(char => `${char}${char}`)
					.join("")
			: digits

	return `#${expanded}`
}

// SDK 0.4.35 made a public link's password a tagged PasswordState instead of an optional
// plaintext. A user-entered password becomes Known (plaintext available for decryption);
// with nothing entered the link's OWN state is passed through unchanged (None for an
// unprotected link, Hashed for a protected one — where the SDK then fails with
// WrongPassword, which the open/list flows already turn into a password prompt).
export function linkPasswordState(entered: string | undefined, current: PasswordState): PasswordState {
	return entered !== undefined ? new PasswordState.Known(entered) : current
}

export type LinkedRoot = {
	dir: AnyLinkedDir
	meta: DirPublicLink
	rootUuid: string
}

// A directory link's root as it is listed, copied and cached (cache.linkedRootByLinkUuid), built from its link
// info and the password the visitor entered.
export function linkedRootOf(info: DirPublicInfo, password: string | undefined): LinkedRoot {
	return {
		dir: new AnyLinkedDir.Root(info.root),
		meta: {
			...info.link,
			password: linkPasswordState(password, info.link.password)
		},
		rootUuid: info.root.inner.uuid
	}
}
