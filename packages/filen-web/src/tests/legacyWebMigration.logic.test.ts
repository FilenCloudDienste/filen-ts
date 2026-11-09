import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	LEGACY_KEEP_MS,
	LEGACY_MARKER_KEY,
	legacyWebWork,
	mapLegacyDismissedAnnouncements,
	mapLegacyLanguage,
	mapLegacyNoteType,
	mapLegacySortPreferences,
	mapLegacyViewModePreferences,
	noteAccountReadForLegacyImport,
	prepareLegacyWebStartup,
	readLegacyMarker,
	writeLegacyMarker
} from "@/lib/legacyWebMigration.logic"
import { DEFAULT_SORT_PREFERENCES, DEFAULT_VIEW_MODE_PREFERENCES } from "@/features/drive/lib/preferences"
import { readSignedInHint } from "@/lib/signedInHint"

const ROOT = "00000000-0000-4000-8000-000000000001"
const DIR = "11111111-1111-4111-8111-111111111111"
const LANGUAGE_KEY = "filen.language"

let store: Map<string, string>

beforeEach(() => {
	store = new Map()

	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key)
	})
})

describe("legacyWebWork", () => {
	it("marks a browser that never ran the previous app done, so later boots read one key", () => {
		expect(legacyWebWork(1000)).toBe("none")
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("migrates when any of the previous app's keys is present", () => {
		store.set("authed:4:4:4", "true")
		expect(legacyWebWork(1000)).toBe("migrate")
		expect(readLegacyMarker()).toBeNull()
	})

	it("keeps an import's copies for seven days, then wipes", () => {
		writeLegacyMarker({ stage: "imported", at: 1000, verified: true })

		expect(legacyWebWork(1000 + LEGACY_KEEP_MS - 1)).toBe("none")
		expect(legacyWebWork(1000 + LEGACY_KEEP_MS)).toBe("wipe")
	})

	it("restarts the wait when the clock was set back", () => {
		writeLegacyMarker({ stage: "imported", at: 5000, verified: true })

		expect(legacyWebWork(2000)).toBe("none")
		expect(readLegacyMarker()?.at).toBe(2000)
		expect(legacyWebWork(2000 + LEGACY_KEEP_MS)).toBe("wipe")
	})

	it("wipes at once when nothing was kept, and does nothing once done", () => {
		writeLegacyMarker({ stage: "retired" })
		expect(legacyWebWork(1000)).toBe("wipe")
		writeLegacyMarker({ stage: "done" })
		expect(legacyWebWork(1000)).toBe("none")
		writeLegacyMarker({ stage: "pending", attempts: 1 })
		expect(legacyWebWork(1000)).toBe("migrate")
	})

	it("removes a session an open previous-app tab wrote back after everything was gone", () => {
		writeLegacyMarker({ stage: "done" })
		store.set("authed:4:4:4", "true")
		expect(legacyWebWork(1000)).toBe("wipe")
	})

	it("reads a malformed marker as none", () => {
		store.set(LEGACY_MARKER_KEY, "{")
		expect(readLegacyMarker()).toBeNull()
		store.set(LEGACY_MARKER_KEY, JSON.stringify({ stage: "other" }))
		expect(readLegacyMarker()).toBeNull()
	})
})

describe("verifying an import made offline", () => {
	it("marks it verified on the first account read once a boot found it unverified", () => {
		writeLegacyMarker({ stage: "imported", at: 1000, verified: false })
		legacyWebWork(2000)
		noteAccountReadForLegacyImport()

		expect(readLegacyMarker()).toEqual({ stage: "imported", at: 1000, verified: true })
	})
})

describe("mapLegacyLanguage", () => {
	it.each([
		["de", "de"],
		["en-US", "en"],
		["ua", "uk"],
		["uk", "uk"],
		["pt", "pt-BR"],
		["zh", "zh"],
		["sv", "sv"]
	])("%s → %s", (raw, expected) => {
		expect(mapLegacyLanguage(raw)).toBe(expected)
	})

	it.each(["xx", "", "  "])("ignores %j", raw => {
		expect(mapLegacyLanguage(raw)).toBeNull()
	})
})

describe("prepareLegacyWebStartup", () => {
	it("imports the previous language into an empty pick, once", () => {
		store.set("i18nextLng", "ua")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(store.get(LANGUAGE_KEY)).toBe("uk")

		// Clearing the pick (follow the browser) sticks.
		store.delete(LANGUAGE_KEY)
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(store.has(LANGUAGE_KEY)).toBe(false)
	})

	it("never overwrites a pick made here, nor stores a language not shipped", () => {
		store.set("i18nextLng", "de")
		store.set(LANGUAGE_KEY, "fr")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(store.get(LANGUAGE_KEY)).toBe("fr")

		store.clear()
		store.set("i18nextLng", "xx")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(store.has(LANGUAGE_KEY)).toBe(false)
	})

	it("tells the splash a session is coming only when one is about to be imported", () => {
		store.set("authed:4:4:4", "true")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(readSignedInHint()).toBe(true)

		store.clear()
		writeLegacyMarker({ stage: "retired" })
		store.set("authed:4:4:4", "true")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(readSignedInHint()).toBe(false)
	})

	it("does nothing once the previous app is gone", () => {
		writeLegacyMarker({ stage: "done" })
		store.set("i18nextLng", "de")
		prepareLegacyWebStartup(LANGUAGE_KEY)
		expect(store.has(LANGUAGE_KEY)).toBe(false)
	})
})

describe("drive sort and view mapping", () => {
	it("maps the previous route keys to this app's per-directory keys", () => {
		const sort = JSON.stringify({
			[ROOT]: "sizeDesc",
			[DIR.toUpperCase()]: "nameDesc",
			recents: "nameAsc",
			favorites: "lastModifiedDesc",
			trash: "sizeAsc",
			links: "nameAsc",
			"shared-in": "lastModifiedAsc",
			"shared-out": "nameDesc",
			// A public-link route part and a value this app has no counterpart for.
			"some-hash-part": "nameAsc",
			[`${DIR.slice(0, -1)}2`]: "typeAsc"
		})

		expect(mapLegacySortPreferences(sort, ROOT, DEFAULT_SORT_PREFERENCES)).toEqual({
			mode: "perDirectory",
			global: DEFAULT_SORT_PREFERENCES.global,
			perDirectory: {
				"drive:": "sizeDesc",
				[`drive:${DIR}`]: "nameDesc",
				"favorites:": "lastModifiedDesc",
				"trash:": "sizeAsc",
				"links:": "nameAsc",
				"sharedIn:": "lastModifiedAsc",
				"sharedOut:": "nameDesc"
			}
		})
	})

	it("keeps recents' view mode, which this app also has per directory", () => {
		expect(
			mapLegacyViewModePreferences(
				JSON.stringify({ recents: "grid", [ROOT]: "list", other: "grid" }),
				ROOT,
				DEFAULT_VIEW_MODE_PREFERENCES
			)
		).toEqual({ mode: "perDirectory", global: "list", perDirectory: { "recents:": "grid", "drive:": "list" } })
	})

	it("maps the root as a plain directory when the account is unknown", () => {
		expect(mapLegacyViewModePreferences(JSON.stringify({ [ROOT]: "grid" }), null, DEFAULT_VIEW_MODE_PREFERENCES)?.perDirectory).toEqual(
			{
				[`drive:${ROOT}`]: "grid"
			}
		)
	})

	it.each([null, "{", "[]", JSON.stringify({ x: "grid" }), JSON.stringify("grid")])("imports nothing from %j", raw => {
		expect(mapLegacyViewModePreferences(raw, ROOT, DEFAULT_VIEW_MODE_PREFERENCES)).toBeNull()
		expect(mapLegacySortPreferences(raw, ROOT, DEFAULT_SORT_PREFERENCES)).toBeNull()
	})
})

describe("note type and announcements", () => {
	it("takes the previous default note type verbatim", () => {
		expect(mapLegacyNoteType(JSON.stringify("checklist"))).toBe("checklist")
		expect(mapLegacyNoteType(JSON.stringify("slides"))).toBeNull()
		expect(mapLegacyNoteType("md")).toBeNull()
		expect(mapLegacyNoteType(null)).toBeNull()
	})

	it("takes the dismissed announcements", () => {
		expect(mapLegacyDismissedAnnouncements(JSON.stringify(["a", "b"]))).toEqual(["a", "b"])
		expect(mapLegacyDismissedAnnouncements(JSON.stringify([]))).toBeNull()
		expect(mapLegacyDismissedAnnouncements(JSON.stringify([1]))).toBeNull()
	})
})
