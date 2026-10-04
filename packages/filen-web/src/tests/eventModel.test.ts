import { describe, expect, it } from "vitest"
import type { FileMeta, UserEventFileInfo, UserEventKind } from "@filen/sdk-rs"
import {
	createEventDescriber,
	describeEvent,
	detectNewDevices,
	dirMetaName,
	entryCategory,
	eventCategory,
	eventDayLabel,
	eventDetailSections,
	eventSearchText,
	fileMetaFields,
	groupEventsByDay,
	parseEventUserAgent,
	securitySummary,
	type EventListRow
} from "@/features/settings/lib/eventModel"
import { selectEventsView, type EventEntry } from "@/features/settings/lib/eventsPagination"
import { testEventModelContext } from "@/tests/support/eventModelContext"
import { testUuid } from "@/tests/support/uuid"

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
const SECRET_KEY = "super-secret-file-key"

const ROOT = testUuid("root")
const DOCUMENTS = testUuid("docs")
const FILE = testUuid("file")
const NEXT = testUuid("next")
const STABLE = testUuid("stable")

const base = { ip: "203.0.113.7", userAgent: CHROME_MAC }

function decodedFile(name: string, mime = "application/pdf", size = 2_202_009n): FileMeta {
	return { type: "decoded", data: { name, mime, modified: 1_690_000_000_000n, size, key: SECRET_KEY, version: 2 } }
}

function decodedDir(name: string) {
	return { type: "decoded" as const, data: { name } }
}

function fileInfo(overrides: Partial<UserEventFileInfo> = {}): UserEventFileInfo {
	return {
		...base,
		metadata: decodedFile("report.pdf"),
		uuid: FILE,
		stableUuid: STABLE,
		newUuid: undefined,
		parent: DOCUMENTS,
		bucket: undefined,
		region: undefined,
		rm: undefined,
		chunks: 1n,
		version: 2,
		favorited: undefined,
		timestamp: 0n,
		currentUuid: undefined,
		...overrides
	}
}

function folderInfo(name = "Photos") {
	return { ...base, name: decodedDir(name), uuid: testUuid("dir"), parent: ROOT, timestamp: 0n }
}

let nextId = 1n

function entry(kind: UserEventKind, timestamp = 1_700_000_000_000n): EventEntry {
	const id = nextId++

	return { type: "ok", key: id.toString(), timestamp, event: { type: "ok", id, timestamp, uuid: testUuid("evt"), kind } }
}

function unknown(raw: Record<string, unknown>, timestamp = 1_700_000_000_000n): EventEntry {
	const view = selectEventsView([
		{ type: "err", message: "unknown variant", raw: JSON.stringify({ timestamp: Number(timestamp), ...raw }) }
	])
	const found = view.entries[0]

	if (found === undefined) {
		throw new Error("no entry")
	}

	return found
}

const ctx = testEventModelContext({
	rootUuid: ROOT,
	directoryName: uuid => (uuid === DOCUMENTS ? "Documents" : undefined),
	contact: email => (email === "anna@example.com" ? { name: "Anna" } : undefined)
})

const describe_ = (e: EventEntry) => describeEvent(e, ctx)

// Every kind: its category, sentence and tone.
const KINDS: readonly (readonly [UserEventKind, string, string, string])[] = [
	[{ type: "fileUploaded", ...fileInfo() }, "files", "Uploaded report.pdf", "default"],
	[{ type: "fileVersioned", ...fileInfo({ newUuid: NEXT }) }, "files", "Uploaded a new version of report.pdf", "default"],
	[{ type: "fileRestored", ...fileInfo() }, "files", "Restored report.pdf from the trash", "default"],
	[{ type: "versionedFileRestored", ...fileInfo() }, "files", "Restored an older version of report.pdf", "default"],
	[{ type: "fileMoved", ...fileInfo() }, "files", "Moved report.pdf", "default"],
	[
		{
			type: "fileRenamed",
			...base,
			metadata: decodedFile("todo.txt"),
			oldMetadata: decodedFile("notes.txt"),
			uuid: FILE,
			stableUuid: STABLE
		},
		"files",
		"Renamed notes.txt → todo.txt",
		"default"
	],
	[
		{
			type: "fileMetadataChanged",
			...base,
			metadata: decodedFile("a.txt"),
			oldMetadata: decodedFile("a.txt"),
			uuid: FILE,
			stableUuid: STABLE
		},
		"files",
		"Updated a.txt",
		"default"
	],
	[{ type: "fileTrash", ...fileInfo() }, "files", "Moved report.pdf to the trash", "default"],
	[{ type: "fileRm", ...fileInfo() }, "files", "Deleted report.pdf", "default"],
	[
		{
			type: "fileShared",
			...base,
			metadata: decodedFile("report.pdf"),
			receiverEmail: "anna@example.com",
			uuid: FILE,
			parent: DOCUMENTS
		},
		"sharing",
		"Shared report.pdf with Anna",
		"default"
	],
	[
		{ type: "fileLinkEdited", ...base, metadata: decodedFile("report.pdf"), uuid: FILE, linkUuid: testUuid("link") },
		"sharing",
		"Changed the public link of report.pdf",
		"default"
	],
	[{ type: "deleteFilePermanently", ...fileInfo() }, "files", "Permanently deleted report.pdf", "default"],
	[{ type: "folderTrash", ...folderInfo() }, "directories", "Moved Photos to the trash", "default"],
	[
		{
			type: "folderShared",
			...base,
			name: decodedDir("Photos"),
			receiverEmail: "bob@example.com",
			uuid: testUuid("dir"),
			parent: ROOT
		},
		"sharing",
		"Shared Photos with bob@example.com",
		"default"
	],
	[{ type: "folderMoved", ...folderInfo() }, "directories", "Moved Photos", "default"],
	[
		{ type: "folderRenamed", ...base, name: decodedDir("Pictures"), oldName: decodedDir("Photos"), uuid: testUuid("dir") },
		"directories",
		"Renamed Photos → Pictures",
		"default"
	],
	[
		{ type: "folderMetadataChanged", ...base, name: decodedDir("Photos"), oldName: decodedDir("Photos"), uuid: testUuid("dir") },
		"directories",
		"Updated Photos",
		"default"
	],
	[{ type: "subFolderCreated", ...folderInfo() }, "directories", "Created Photos", "default"],
	[{ type: "baseFolderCreated", ...folderInfo() }, "directories", "Created Photos", "default"],
	[{ type: "folderRestored", ...folderInfo() }, "directories", "Restored Photos from the trash", "default"],
	[
		{ type: "folderColorChanged", ...base, name: decodedDir("Photos"), uuid: testUuid("dir"), color: "red", oldColor: "default" },
		"directories",
		"Changed the color of Photos",
		"default"
	],
	[{ type: "deleteFolderPermanently", ...folderInfo() }, "directories", "Permanently deleted Photos", "default"],
	[{ type: "login", ...base }, "security", "Signed in", "default"],
	[{ type: "failedLogin", ...base }, "security", "Failed sign-in attempt", "danger"],
	[{ type: "passwordChanged", ...base }, "security", "Changed your password", "warning"],
	[{ type: "twoFaEnabled", ...base }, "security", "Turned on two-factor authentication", "warning"],
	[{ type: "twoFaDisabled", ...base }, "security", "Turned off two-factor authentication", "warning"],
	[{ type: "requestAccountDeletion", ...base }, "account", "Requested account deletion", "warning"],
	[{ type: "trashEmptied", ...base }, "files", "Emptied the trash", "default"],
	[{ type: "deleteAll", ...base }, "files", "Deleted all files and directories", "default"],
	[{ type: "deleteVersioned", ...base }, "files", "Deleted all old file versions", "default"],
	[{ type: "deleteUnfinished", ...base }, "files", "Deleted unfinished uploads", "default"],
	[{ type: "codeRedeemed", ...base, code: "WELCOME" }, "account", "Redeemed code WELCOME", "default"],
	[{ type: "emailChanged", ...base, email: "new@example.com" }, "account", "Changed your email address to new@example.com", "warning"],
	[
		{ type: "emailChangeAttempt", ...base, email: "old@example.com", oldEmail: "old@example.com", newEmail: "new@example.com" },
		"account",
		"Requested an email change to new@example.com",
		"warning"
	],
	[
		{ type: "removedSharedInItems", ...base, count: 1n, sharerEmail: "anna@example.com" },
		"sharing",
		"Removed 1 item shared by Anna",
		"default"
	],
	[
		{ type: "removedSharedOutItems", ...base, count: 3n, receiverEmail: "bob@example.com" },
		"sharing",
		"Stopped sharing 3 items with bob@example.com",
		"default"
	],
	[
		{ type: "folderLinkEdited", ...base, linkUuid: testUuid("link"), uuid: testUuid("dir") },
		"sharing",
		"Changed a public directory link",
		"default"
	],
	[
		{
			type: "itemFavorite",
			...base,
			value: true,
			metadata: decodedFile("report.pdf"),
			uuid: FILE,
			stableUuid: STABLE,
			itemType: "file"
		},
		"files",
		"Added report.pdf to favorites",
		"default"
	]
]

describe("describeEvent", () => {
	it("covers every kind", () => {
		expect(new Set(KINDS.map(([kind]) => kind.type)).size).toBe(39)
	})

	for (const [kind, category, title, tone] of KINDS) {
		it(`describes ${kind.type}`, () => {
			const description = describe_(entry(kind))

			expect(eventCategory(kind)).toBe(category)
			expect(description.category).toBe(category)
			expect(description.title).toBe(title)
			expect(description.tone).toBe(tone)
			expect(
				JSON.stringify(description, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value))
			).not.toContain(SECRET_KEY)
		})
	}

	it("names a file's type glyph and the item behind a file event", () => {
		const description = describe_(entry({ type: "fileUploaded", ...fileInfo() }))

		expect(description.icon).toBe("upload")
		expect(description.fileIcon).toBe("pdf")
		expect(description.item).toEqual({ type: "file", uuid: FILE, stableUuid: STABLE, parent: DOCUMENTS })
	})

	it("builds the second line from the cached location, the size and the device", () => {
		// The name is direction-isolated (FSI … PDI).
		expect(describe_(entry({ type: "fileUploaded", ...fileInfo() })).secondary).toEqual([
			"in \u2068Documents\u2069",
			"2.1 MiB",
			"Chrome on macOS"
		])
		expect(describe_(entry({ type: "fileMoved", ...fileInfo() })).secondary[0]).toBe("to \u2068Documents\u2069")
		expect(describe_(entry({ type: "folderMoved", ...folderInfo() })).location).toBe("Cloud Drive")
	})

	it("leaves out a location no cache holds", () => {
		const description = describe_(entry({ type: "fileUploaded", ...fileInfo({ parent: testUuid("elsewhere") }) }))

		expect(description.location).toBeUndefined()
		expect(description.secondary).toEqual(["2.1 MiB", "Chrome on macOS"])
	})

	it("adds the IP to a security event's second line", () => {
		expect(describe_(entry({ type: "login", ...base })).secondary).toEqual(["Chrome on macOS", "203.0.113.7"])
	})

	it("relabels a trash with a successor as a replacement, pointing at the successor", () => {
		const description = describe_(entry({ type: "fileTrash", ...fileInfo({ newUuid: NEXT }) }))

		expect(description.title).toBe("Replaced report.pdf with a new version")
		expect(description.item?.uuid).toBe(NEXT)
	})

	it("points a new version at its successor", () => {
		expect(describe_(entry({ type: "fileVersioned", ...fileInfo({ newUuid: NEXT }) })).item?.uuid).toBe(NEXT)
	})

	it("tells a delete of old versions from a delete of the file", () => {
		const oldVersions = describe_(entry({ type: "deleteFilePermanently", ...fileInfo({ stableUuid: undefined }) }))

		expect(oldVersions.title).toBe("Deleted old versions of report.pdf")
		// Its uuid is the archived version's, gone with it.
		expect(oldVersions.item?.versionOnly).toBe(true)
		expect(describe_(entry({ type: "deleteFilePermanently", ...fileInfo() })).item?.versionOnly).toBeUndefined()
		// Legacy events carry no ids at all.
		expect(describe_(entry({ type: "deleteFilePermanently", ...fileInfo({ uuid: undefined, stableUuid: undefined }) })).title).toBe(
			"Permanently deleted report.pdf"
		)
	})

	it("names a directory link from the caches when it can", () => {
		const description = describe_(entry({ type: "folderLinkEdited", ...base, linkUuid: testUuid("link"), uuid: DOCUMENTS }))

		expect(description.title).toBe("Changed the public link of Documents")
	})

	it("reads favourite on and off, and a directory favourite as a directory", () => {
		const off = describe_(
			entry({
				type: "itemFavorite",
				...base,
				value: false,
				metadata: { type: "decryptedUTF8", data: '{"name":"Photos"}' },
				uuid: testUuid("dir"),
				stableUuid: undefined,
				itemType: "folder"
			})
		)

		expect(off.title).toBe("Removed Photos from favorites")
		expect(off.icon).toBe("unfavorite")
		expect(off.category).toBe("directories")
		expect(off.fileIcon).toBeUndefined()
		expect(off.item?.type).toBe("directory")
	})

	it("treats a rename event with a changed name as a rename and an unchanged one as an update", () => {
		const changed = describe_(
			entry({
				type: "fileMetadataChanged",
				...base,
				metadata: decodedFile("b.txt"),
				oldMetadata: decodedFile("a.txt"),
				uuid: FILE,
				stableUuid: STABLE
			})
		)
		const same = describe_(
			entry({
				type: "fileRenamed",
				...base,
				metadata: decodedFile("a.txt"),
				oldMetadata: decodedFile("a.txt"),
				uuid: FILE,
				stableUuid: STABLE
			})
		)

		expect(changed.title).toBe("Renamed a.txt → b.txt")
		expect(same.title).toBe("Updated a.txt")
	})

	it("falls back to a neutral name for an item it can't read", () => {
		expect(describe_(entry({ type: "fileUploaded", ...fileInfo({ metadata: { type: "encrypted", data: "x" } }) })).title).toBe(
			"Uploaded a file"
		)
		expect(describe_(entry({ type: "folderTrash", ...folderInfo(), name: { type: "rSAEncrypted", data: "x" } })).title).toBe(
			"Moved a directory to the trash"
		)
		expect(
			describe_(
				entry({
					type: "itemFavorite",
					...base,
					value: true,
					metadata: { type: "encrypted", data: "x" },
					uuid: FILE,
					stableUuid: undefined,
					itemType: undefined
				})
			).title
		).toBe("Added an item to favorites")
	})

	it("describes an undecodable event from its raw fields", () => {
		const description = describe_(unknown({ id: 5, type: "fileArchived", info: { ip: "198.51.100.1", userAgent: FIREFOX_LINUX } }))

		expect(description.title).toBe("Unknown event (fileArchived)")
		expect(description.icon).toBe("unknown")
		expect(description.category).toBeUndefined()
		expect(description.deviceLabel).toBe("Firefox on Linux")
		expect(description.ip).toBe("198.51.100.1")
		// The second line shows where it came from, the IP once, whatever its category.
		expect(description.secondary).toEqual(["Firefox on Linux", "198.51.100.1"])
		expect(describe_(unknown({ type: "failedLogin", info: { ip: "198.51.100.1" } })).secondary).toEqual([
			"Unknown device",
			"198.51.100.1"
		])
		expect(describe_(unknown({})).title).toBe("Unknown event")
	})

	it("marks a name with invisible or direction-changing characters", () => {
		const meta = (name: string): FileMeta => ({
			type: "decoded",
			data: { name, mime: "application/pdf", modified: 0n, size: 1n, key: SECRET_KEY, version: 2 }
		})

		expect(describe_(entry({ type: "fileUploaded", ...fileInfo({ metadata: meta("invoice\u202Efdp.exe") }) })).misleading).toBe(true)
		expect(describe_(entry({ type: "fileUploaded", ...fileInfo({ metadata: meta("zero\u200Bwidth.txt") }) })).misleading).toBe(true)
		expect(describe_(entry({ type: "fileUploaded", ...fileInfo({ metadata: meta("plain päth.pdf") }) })).misleading).toBeUndefined()
	})

	it("files an undecodable event of a known raw type under its category and tone", () => {
		const twoFactor = unknown({ type: "2faEnabled" })

		expect(entryCategory(twoFactor)).toBe("security")
		expect(describe_(twoFactor).tone).toBe("warning")
		expect(entryCategory(unknown({ type: "toString" }))).toBeUndefined()
	})
})

describe("item metadata", () => {
	it("reads decoded metadata and never the key", () => {
		expect(fileMetaFields(decodedFile("a.pdf", "application/pdf", 10n))).toEqual({
			name: "a.pdf",
			mime: "application/pdf",
			size: 10,
			modified: 1_690_000_000_000
		})
	})

	it("reads legacy raw JSON metadata", () => {
		const json = JSON.stringify({ name: "old.txt", mime: "text/plain", size: 12, lastModified: 1_600_000_000_000, key: SECRET_KEY })

		expect(fileMetaFields({ type: "decryptedUTF8", data: json })).toEqual({
			name: "old.txt",
			mime: "text/plain",
			size: 12,
			modified: 1_600_000_000_000
		})
		expect(fileMetaFields({ type: "decryptedRaw", data: [...new TextEncoder().encode(json)] }).name).toBe("old.txt")
	})

	it("reads nothing from metadata it can't trust", () => {
		expect(fileMetaFields({ type: "decryptedUTF8", data: "nope" })).toEqual({})
		expect(fileMetaFields({ type: "decryptedUTF8", data: '{"name":3,"size":-1}' })).toEqual({})
		expect(fileMetaFields({ type: "encrypted", data: "x" })).toEqual({})
		expect(fileMetaFields(undefined)).toEqual({})
		expect(dirMetaName({ type: "decryptedUTF8", data: '{"name":"Docs"}' })).toBe("Docs")
		expect(dirMetaName({ type: "encrypted", data: "x" })).toBeUndefined()
	})
})

describe("eventSearchText", () => {
	it("holds names, raw emails and contact names, IP, device and the sentence, lowercased", () => {
		const text = eventSearchText(
			entry({
				type: "fileShared",
				...base,
				metadata: decodedFile("Report.PDF"),
				receiverEmail: "anna@example.com",
				uuid: FILE,
				parent: DOCUMENTS
			}),
			ctx
		)

		for (const part of [
			"report.pdf",
			"anna@example.com",
			"anna",
			"203.0.113.7",
			"chrome on macos",
			"shared report.pdf with anna",
			"documents"
		]) {
			expect(text).toContain(part)
		}

		expect(text).toBe(text.toLowerCase())
	})

	it("holds both names of a rename and every email of an email change", () => {
		const rename = eventSearchText(
			entry({
				type: "fileRenamed",
				...base,
				metadata: decodedFile("new.txt"),
				oldMetadata: decodedFile("old.txt"),
				uuid: FILE,
				stableUuid: STABLE
			}),
			ctx
		)
		const email = eventSearchText(
			entry({ type: "emailChangeAttempt", ...base, email: "a@x.io", oldEmail: "a@x.io", newEmail: "b@x.io" }),
			ctx
		)

		expect(rename).toContain("old.txt")
		expect(rename).toContain("new.txt")
		expect(email).toContain("a@x.io")
		expect(email).toContain("b@x.io")
	})
})

describe("createEventDescriber", () => {
	it("describes each event once per context", () => {
		const describer = createEventDescriber(ctx)
		const first = entry({ type: "login", ...base })
		// The same event re-wrapped, as a new cache write does.
		const rewrapped: EventEntry = { ...first }

		expect(describer.describe(rewrapped)).toBe(describer.describe(first))
		expect(describer.searchText(first)).toBe(eventSearchText(first, ctx))
	})
})

describe("groupEventsByDay", () => {
	// Local noon, so no test-machine time zone moves an event across midnight.
	const now = new Date(2026, 9, 4, 12).getTime()
	const at = (day: number, hour: number) => BigInt(new Date(2026, 9, day, hour).getTime())

	it("puts a header before each day's events, newest first", () => {
		const entries = [
			entry({ type: "login", ...base }, at(4, 11)),
			entry({ type: "login", ...base }, at(4, 1)),
			entry({ type: "login", ...base }, at(3, 22)),
			entry({ type: "login", ...base }, at(1, 9))
		]
		const rows = groupEventsByDay(entries, now)

		expect(rows.map(row => (row.type === "day" ? row.day : "event"))).toEqual([
			"today",
			"event",
			"event",
			"yesterday",
			"event",
			"earlier",
			"event"
		])
		expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
	})

	it("labels the days", () => {
		const t = ctx.t
		const day = (dayStart: number, kind: "today" | "yesterday" | "earlier"): Extract<EventListRow, { type: "day" }> => ({
			type: "day",
			key: "d",
			day: kind,
			dayStart
		})

		expect(eventDayLabel(day(now, "today"), t, now)).toBe("Today")
		expect(eventDayLabel(day(now, "yesterday"), t, now)).toBe("Yesterday")
		expect(eventDayLabel(day(new Date(2026, 9, 1).getTime(), "earlier"), t, now)).toContain("1")
		expect(eventDayLabel(day(new Date(2025, 9, 1).getTime(), "earlier"), t, now)).toContain("2025")
	})

	it("returns nothing for no entries", () => {
		expect(groupEventsByDay([], now)).toEqual([])
	})
})

describe("parseEventUserAgent", () => {
	it("evicts the least recently used user agent, never the whole cache", () => {
		const first = parseEventUserAgent("lru-first/1")
		const oldestFiller = parseEventUserAgent("lru-filler/0")

		for (let i = 1; i < 62; i++) {
			parseEventUserAgent(`lru-filler/${String(i)}`)
		}

		const last = parseEventUserAgent("lru-last/1")

		// Used again, so the next new one evicts the oldest filler instead.
		expect(parseEventUserAgent("lru-first/1")).toBe(first)

		parseEventUserAgent("lru-new/1")

		expect(parseEventUserAgent("lru-first/1")).toBe(first)
		expect(parseEventUserAgent("lru-last/1")).toBe(last)
		expect(parseEventUserAgent("lru-filler/0")).not.toBe(oldestFiller)
	})

	it("keys a long user agent by the part the parser reads", () => {
		const long = `Firefox/131.0 ${"x".repeat(50_000)}`

		expect(parseEventUserAgent(long)).toBe(parseEventUserAgent(`${long}y`))
	})
})

describe("detectNewDevices", () => {
	it("marks the oldest entry of each browser and OS combination, skipping unreadable user agents", () => {
		// Newest first.
		const entries = [
			entry({ type: "login", ip: "", userAgent: FIREFOX_LINUX }, 5n),
			entry({ type: "login", ip: "", userAgent: CHROME_MAC }, 4n),
			entry({ type: "login", ip: "", userAgent: FIREFOX_LINUX }, 3n),
			entry({ type: "login", ip: "", userAgent: "" }, 2n),
			entry({ type: "login", ip: "", userAgent: CHROME_MAC }, 1n)
		]

		expect(detectNewDevices(entries)).toEqual(new Set([entries[2]?.key, entries[4]?.key]))
	})
})

describe("securitySummary", () => {
	const now = 1_700_000_000_000
	const day = 24 * 60 * 60 * 1000
	const ago = (days: number) => BigInt(now - days * day)

	it("reads the latest sign-in, password and two-factor change, and counts failed sign-ins over 7 days", () => {
		const lastLogin = entry({ type: "login", ...base }, ago(1))
		const password = entry({ type: "passwordChanged", ...base }, ago(3))
		const twoFactor = entry({ type: "twoFaDisabled", ...base }, ago(4))
		const entries = [
			lastLogin,
			entry({ type: "failedLogin", ...base }, ago(2)),
			password,
			twoFactor,
			entry({ type: "failedLogin", ...base }, ago(6)),
			entry({ type: "login", ...base }, ago(7)),
			entry({ type: "twoFaEnabled", ...base }, ago(8)),
			entry({ type: "failedLogin", ...base }, ago(9))
		]

		expect(securitySummary(entries, now)).toEqual({
			lastLogin,
			failedLast7d: 2,
			lastPasswordChange: password,
			last2faChange: { entry: twoFactor, enabled: false }
		})
	})

	it("leaves out what the loaded events don't hold", () => {
		expect(securitySummary([entry({ type: "trashEmptied", ...base }, ago(1))], now)).toEqual({ failedLast7d: 0 })
	})
})

describe("eventDetailSections", () => {
	it("lays out the item, device and identifiers of a file event, never the key", () => {
		const fileEntry = entry({ type: "fileUploaded", ...fileInfo() })
		const sections = eventDetailSections(fileEntry, describe_(fileEntry), ctx)

		expect(sections.item.map(field => field.labelKey)).toEqual([
			"eventsFieldName",
			"eventsFieldType",
			"eventsFieldSize",
			"eventsFieldModified",
			"eventsFieldLocation"
		])
		expect(sections.device).toEqual([
			{ labelKey: "eventsFieldBrowser", value: "Chrome 129.0.0.0" },
			{ labelKey: "eventsFieldOperatingSystem", value: "macOS 10.15.7" },
			{ labelKey: "eventsFieldIpAddress", value: "203.0.113.7", opaque: true },
			{ labelKey: "eventsFieldUserAgent", value: CHROME_MAC, opaque: true }
		])
		expect(sections.details.map(field => field.labelKey)).toEqual(["eventsFieldEventId", "eventsFieldItemId"])
		expect(JSON.stringify(sections)).not.toContain(SECRET_KEY)
	})

	it("shows colours old and new, an unsent colour as the default", () => {
		const colorEntry = entry({
			type: "folderColorChanged",
			...base,
			name: decodedDir("Photos"),
			uuid: testUuid("dir"),
			color: "#112233",
			oldColor: undefined as unknown as string
		})
		const fields = eventDetailSections(colorEntry, describe_(colorEntry), ctx).item

		expect(fields.find(field => field.labelKey === "eventsFieldPreviousColor")).toMatchObject({ value: "Default", color: "#85BCFF" })
		expect(fields.find(field => field.labelKey === "eventsFieldColor")).toMatchObject({
			value: "Custom color",
			hint: "#112233",
			color: "#112233"
		})
	})

	it("names colours as the drive does, a malformed one as the default it paints as", () => {
		const colorEntry = entry({
			type: "folderColorChanged",
			...base,
			name: decodedDir("Photos"),
			uuid: testUuid("dir"),
			color: "purple",
			oldColor: "not-a-color"
		})
		const fields = eventDetailSections(colorEntry, describe_(colorEntry), ctx).item

		expect(fields.find(field => field.labelKey === "eventsFieldColor")).toEqual({
			labelKey: "eventsFieldColor",
			value: "Purple",
			color: "#AF52DE"
		})
		expect(fields.find(field => field.labelKey === "eventsFieldPreviousColor")).toEqual({
			labelKey: "eventsFieldPreviousColor",
			value: "Default",
			color: "#85BCFF"
		})
	})

	it("reads an undecodable event's type and id", () => {
		const raw = unknown({ id: 77, type: "fileArchived" })
		const sections = eventDetailSections(raw, describe_(raw), ctx)

		expect(sections.item).toEqual([])
		expect(sections.details).toEqual([
			{ labelKey: "eventsFieldEventType", value: "fileArchived" },
			{ labelKey: "eventsFieldEventId", value: "77", opaque: true }
		])
	})
})
