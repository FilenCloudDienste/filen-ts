import { type } from "arktype"
import type { NoteType } from "@filen/sdk-rs"
import { LEGACY_SESSION_KEYS } from "@filen/shared/legacySession"
import { resolveLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@filen/shared/languages"
import { writeSignedInHint } from "@/lib/signedInHint"
import type { DriveSortBy } from "@/features/drive/lib/sort"
import type { DrivePreferences, DriveViewMode } from "@/features/drive/lib/preferences"

// The previous web app ran on this origin and left its state here. Kept free of worker and storage imports: the
// account query and the pre-boot language import read it too.

// Where the previous app's localStorage values the import reads live. Raw strings; every one but i18nextLng is JSON.
export const LEGACY_PREF_KEYS = {
	language: "i18nextLng",
	noteType: "defaultNoteType",
	sortBy: "driveSortBy",
	listType: "listType",
	dismissedAnnouncements: "dismissedAnnouncements"
} as const

// Every localStorage key the previous app wrote, removed by the wipe by name (never localStorage.clear(), which
// would take this app's keys too). Secret copies: the session, desktopConfig (another session copy), the old PIN
// lock, WebDAV/S3 credentials in the desktop configs. The rest is leftover UI state.
export const LEGACY_LOCAL_KEYS: readonly string[] = [
	LEGACY_SESSION_KEYS.authed,
	LEGACY_SESSION_KEYS.sdkConfig,
	"desktopConfig:4:4",
	"lockPin",
	"lockTimeout",
	"lockNextTry",
	"syncConfig:1",
	"networkDriveConfig:1",
	"webdavConfig:1",
	"s3Config:1",
	...Object.values(LEGACY_PREF_KEYS),
	"cookieConsent",
	"videoPlayerVolume",
	"audioPlayerVolume",
	"chatNotificationsEnabled",
	"contactNotificationsEnabled",
	"notificationSoundEnabled",
	"minimizeToTrayEnabled",
	"startMinimizedEnabled",
	"sideBarTreeOpen",
	"useResizablePanelSizes",
	"mainContainerResizablePanelSizes",
	"mainContainerResizablePanelSizes:notes",
	"textEditorResizablePanelSizes",
	"textEditorResizablePanelSizes:notes",
	"textEditorResizablePanelSizes:publicLink",
	"lastSelectedNote",
	"lastSelectedChatsConversation",
	"lastSelectedSync"
]

// Per-conversation keys the previous chats view wrote; removed by prefix.
export const LEGACY_LOCAL_KEY_PREFIXES: readonly string[] = ["conversationParticipantsContainerOpen:"]

// The previous app's IndexedDB: localForage (more copies of sdkConfig and desktopConfig, so it waits for the wipe
// with the other session copies) and its query cache (decrypted listings, no session: gone at the first import).
export const LEGACY_IDB_SESSION = "Filen"
export const LEGACY_IDB_CACHE = "Filen_reactQuery"

// How long the old session copies stay after an import, so going back to the previous app still works.
export const LEGACY_KEEP_MS = 7 * 24 * 60 * 60 * 1000

// Imports that failed for a reason other than the network before the old copies are given up.
export const LEGACY_MAX_ATTEMPTS = 3

export const LEGACY_MARKER_KEY = "filen.legacyWebMigration.v1"

// pending: the previous app's data was found and not processed yet. imported: its session is this app's now; its copies wait out
// LEGACY_KEEP_MS from `at`. retired: nothing worth keeping (no or a dead session, one already here, a sign-out), so
// the old data goes at once. done: nothing of the previous app is left.
const markerSchema = type({
	stage: "'pending'|'imported'|'retired'|'done'",
	"attempts?": "number.integer >= 0",
	// When the import landed (imported), or the first attempt (pending).
	"at?": "number",
	"verified?": "boolean",
	"language?": "boolean",
	"prefs?": "boolean",
	"cacheWiped?": "boolean",
	"+": "delete"
})

export type LegacyMarker = typeof markerSchema.infer

export function readLegacyMarker(): LegacyMarker | null {
	try {
		const raw = localStorage.getItem(LEGACY_MARKER_KEY)

		if (raw === null) {
			return null
		}

		const marker = markerSchema(JSON.parse(raw))

		return marker instanceof type.errors ? null : marker
	} catch {
		return null
	}
}

export function writeLegacyMarker(marker: LegacyMarker): void {
	try {
		localStorage.setItem(LEGACY_MARKER_KEY, JSON.stringify(marker))
	} catch {
		// Storage blocked: the next boot finds no marker and starts over, which only repeats idempotent steps.
	}
}

// Read and write in one synchronous step, so another tab's write in between is never lost to a stale copy.
export function updateLegacyMarker(change: (marker: LegacyMarker | null) => LegacyMarker): LegacyMarker {
	const next = change(readLegacyMarker())

	writeLegacyMarker(next)

	return next
}

function readLocal(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

export type LegacyWork = "none" | "migrate" | "wipe"

// Whether anything of the previous app is left to look at; two synchronous reads when there is not. A browser that
// never ran the previous app gets a done marker on its first boot. An import whose copies are still kept costs a
// timestamp compare. `now` earlier than the import (a clock set back) restarts the wait from now.
export function legacyWebWork(now: number): LegacyWork {
	const marker = readLegacyMarker()

	if (marker === null) {
		if (LEGACY_LOCAL_KEYS.some(key => readLocal(key) !== null)) {
			return "migrate"
		}

		writeLegacyMarker({ stage: "done" })

		return "none"
	}

	switch (marker.stage) {
		case "done":
			// A previous-app tab still open wrote its session back: never imported again, only removed.
			return readLocal(LEGACY_SESSION_KEYS.authed) === null ? "none" : "wipe"
		case "pending":
			return "migrate"
		case "retired":
			return "wipe"
		case "imported": {
			const at = marker.at ?? now

			if (marker.verified !== true) {
				awaitingVerification = true
			}

			if (now < at) {
				writeLegacyMarker({ ...marker, at: now })

				return "none"
			}

			return now - at >= LEGACY_KEEP_MS ? "wipe" : "none"
		}
	}
}

// An import that could not be verified (offline) is verified by the first account read that succeeds.
let awaitingVerification = false

export function expectLegacyVerification(): void {
	awaitingVerification = true
}

// Called on every successful account read; a flag check unless an import waits for one.
export function noteAccountReadForLegacyImport(): void {
	if (!awaitingVerification) {
		return
	}

	awaitingVerification = false

	const marker = readLegacyMarker()

	if (marker?.stage === "imported" && marker.verified !== true) {
		writeLegacyMarker({ ...marker, verified: true })
	}
}

function parseJson(raw: string | null): unknown {
	if (raw === null) {
		return undefined
	}

	try {
		return JSON.parse(raw) as unknown
	} catch {
		return undefined
	}
}

// The previous app's language codes that differ from this app's tags.
const LEGACY_LANGUAGE_ALIASES: Readonly<Record<string, string>> = { ua: "uk" }

// i18nextLng (a raw tag, not JSON) as one of this app's languages, or null when it names none (it then plays no
// part and the browser's languages decide). Portuguese reads pt-BR, as the shared resolver maps it.
export function mapLegacyLanguage(raw: string | null): SupportedLanguage | null {
	if (raw === null || raw.trim().length === 0) {
		return null
	}

	const tag = raw.trim()

	return resolveLanguage([LEGACY_LANGUAGE_ALIASES[tag.toLowerCase()] ?? tag], SUPPORTED_LANGUAGES)
}

const LEGACY_NOTE_TYPES = ["text", "md", "code", "rich", "checklist"] as const satisfies readonly NoteType[]

const legacyNoteTypeSchema = type.enumerated(...LEGACY_NOTE_TYPES)

export function mapLegacyNoteType(raw: string | null): NoteType | null {
	const value = legacyNoteTypeSchema(parseJson(raw))

	return value instanceof type.errors ? null : value
}

const LEGACY_SORTS = [
	"nameAsc",
	"nameDesc",
	"sizeAsc",
	"sizeDesc",
	"lastModifiedAsc",
	"lastModifiedDesc"
] as const satisfies readonly DriveSortBy[]

const legacySortMapSchema = type({ "[string]": "unknown" })

const legacySortSchema = type.enumerated(...LEGACY_SORTS)

const legacyViewSchema = type("'list'|'grid'")

// UUIDs only: the previous app's maps were also keyed by public-link directories and other route parts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The previous app keyed both maps by the last route segment: a directory uuid (the drive root's for My Drive), or
// one of its fixed views. Each maps to this app's per-directory key (`${variant}:${uuid ?? ""}`); anything else is
// dropped. Recents has a fixed sort here, so only its view mode carries over.
function legacyLocationKey(segment: string, rootUuid: string | null, forSort: boolean): string | null {
	switch (segment) {
		case "recents":
			return forSort ? null : "recents:"
		case "favorites":
		case "trash":
		case "links":
			return `${segment}:`
		case "shared-in":
			return "sharedIn:"
		case "shared-out":
			return "sharedOut:"
	}

	if (!UUID.test(segment)) {
		return null
	}

	return rootUuid !== null && segment.toLowerCase() === rootUuid.toLowerCase() ? "drive:" : `drive:${segment.toLowerCase()}`
}

function mapLegacyEntries<T extends string>(
	raw: string | null,
	rootUuid: string | null,
	valueSchema: (value: unknown) => T | type.errors,
	forSort: boolean
): Record<string, T> | null {
	const map = legacySortMapSchema(parseJson(raw))

	if (map instanceof type.errors || Array.isArray(map)) {
		return null
	}

	const entries: Record<string, T> = {}

	for (const [segment, value] of Object.entries(map)) {
		const key = legacyLocationKey(segment, rootUuid, forSort)
		const parsed = valueSchema(value)

		if (key !== null && !(parsed instanceof type.errors)) {
			entries[key] = parsed
		}
	}

	return Object.keys(entries).length > 0 ? entries : null
}

// The previous app always sorted and showed per directory, so an import turns that mode on and keeps the global
// value at its default.
export function mapLegacySortPreferences(
	raw: string | null,
	rootUuid: string | null,
	fallback: DrivePreferences<DriveSortBy>
): DrivePreferences<DriveSortBy> | null {
	const perDirectory = mapLegacyEntries(raw, rootUuid, value => legacySortSchema(value), true)

	return perDirectory === null ? null : { ...fallback, mode: "perDirectory", perDirectory }
}

export function mapLegacyViewModePreferences(
	raw: string | null,
	rootUuid: string | null,
	fallback: DrivePreferences<DriveViewMode>
): DrivePreferences<DriveViewMode> | null {
	const perDirectory = mapLegacyEntries(raw, rootUuid, value => legacyViewSchema(value), false)

	return perDirectory === null ? null : { ...fallback, mode: "perDirectory", perDirectory }
}

const dismissedSchema = type("string[]")

export function mapLegacyDismissedAnnouncements(raw: string | null): string[] | null {
	const value = dismissedSchema(parseJson(raw))

	return value instanceof type.errors || value.length === 0 ? null : value
}

// Synchronous, once at startup, before the first language detection and the splash read what it writes. Moves the
// previous app's language into an empty pick (once: clearing the pick later, to follow the browser, must stick), and
// tells the splash a session is coming when the boot is about to import one.
export function prepareLegacyWebStartup(languageKey: string): void {
	const marker = readLegacyMarker()

	if (marker?.stage === "done") {
		return
	}

	if ((marker === null || marker.stage === "pending") && readLocal(LEGACY_SESSION_KEYS.authed) === "true") {
		writeSignedInHint(true)
	}

	if (marker?.language === true) {
		return
	}

	const raw = readLocal(LEGACY_PREF_KEYS.language)

	if (raw === null) {
		return
	}

	const language = mapLegacyLanguage(raw)

	try {
		if (language !== null && localStorage.getItem(languageKey) === null) {
			localStorage.setItem(languageKey, language)
		}
	} catch {
		// Storage blocked: the browser's languages decide, as they would without the import.
	}

	updateLegacyMarker(current => ({ ...(current ?? { stage: "pending" }), language: true }))
}
