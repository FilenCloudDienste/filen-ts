import { describe, expect, it } from "vitest"
import type { FileMeta, UserEventFileInfo, UserEventKind, UuidStr } from "@filen/sdk-rs"
import { describeEvent } from "@/features/settings/lib/eventModel"
import { selectEventsView, type EventEntry } from "@/features/settings/lib/eventsPagination"
import {
	buildEventDetailView,
	eventDetailText,
	eventHeroGlyph,
	eventLocationUuid,
	eventLookupFailure,
	eventLookupRef,
	type EventDetailLocation,
	type EventDetailView
} from "@/features/settings/components/events/eventDetailDialog.logic"
import { testEventModelContext } from "@/tests/support/eventModelContext"
import { testUuid } from "@/tests/support/uuid"

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
const SECRET_KEY = "super-secret-file-key"
const ROOT = testUuid("root")
const DOCUMENTS = testUuid("docs")
const ARCHIVE = testUuid("archive")
const FILE = testUuid("file")
const STABLE = testUuid("stable")
const EVENT_UUID = testUuid("evt")

const base = { ip: "203.0.113.7", userAgent: CHROME_MAC }

function decodedFile(name: string, mime = "application/pdf"): FileMeta {
	return { type: "decoded", data: { name, mime, modified: 1_690_000_000_000n, size: 2_202_009n, key: SECRET_KEY, version: 2 } }
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

function entry(kind: UserEventKind): EventEntry {
	return {
		type: "ok",
		key: "1",
		timestamp: 1_700_000_000_000n,
		event: { type: "ok", id: 1n, timestamp: 1_700_000_000_000n, uuid: EVENT_UUID, kind }
	}
}

const ctx = testEventModelContext({
	rootUuid: ROOT,
	directoryName: uuid => (uuid === DOCUMENTS ? "Documents" : undefined),
	contact: email => (email === "anna@example.com" ? { name: "Anna", avatar: "https://example.com/a.png" } : undefined)
})

function view(e: EventEntry, location?: EventDetailLocation): EventDetailView {
	const description = describeEvent(e, ctx)

	return buildEventDetailView(e, description, location ?? cachedLocation(e), ctx)
}

function cachedLocation(e: EventEntry): EventDetailLocation | undefined {
	const description = describeEvent(e, ctx)
	const uuid = eventLocationUuid(description)

	return uuid === undefined || description.location === undefined ? undefined : { status: "resolved", uuid, name: description.location }
}

function rows(v: EventDetailView, key: string) {
	return v.sections.find(section => section.key === key)?.rows ?? []
}

describe("buildEventDetailView", () => {
	it("names a file's kind, places its location and tops up device type, event UUID and stable ID", () => {
		const v = view(entry({ type: "fileUploaded", ...fileInfo() }))

		expect(rows(v, "item").map(row => row.key)).toEqual([
			"eventsFieldName",
			"eventsFieldType",
			"eventsFieldSize",
			"eventsFieldModified",
			"eventsFieldLocation"
		])
		expect(rows(v, "item")[1]).toMatchObject({ value: "PDF document", hint: "application/pdf" })
		expect(rows(v, "item")[0]).toMatchObject({ value: "report.pdf", copy: "report.pdf" })
		expect(rows(v, "item")[4]).toMatchObject({ value: "Documents", location: DOCUMENTS })
		expect(rows(v, "device").map(row => [row.key, row.value])).toEqual([
			["eventsFieldBrowser", "Chrome 129.0.0.0"],
			["eventsFieldOperatingSystem", "macOS 10.15.7"],
			["eventsFieldDeviceType", "Desktop"],
			["eventsFieldIpAddress", "203.0.113.7"],
			["eventsFieldUserAgent", CHROME_MAC]
		])
		expect(rows(v, "device").find(row => row.key === "eventsFieldUserAgent")).toMatchObject({ collapsible: true, copy: CHROME_MAC })
		expect(rows(v, "details").map(row => [row.key, row.value])).toEqual([
			["eventsFieldEventId", "1"],
			["eventsFieldEventUuid", EVENT_UUID],
			["eventsFieldItemId", FILE],
			["eventsFieldStableId", STABLE]
		])
		expect(rows(v, "details").every(row => row.opaque === true && row.copy === row.value)).toBe(true)
		expect(JSON.stringify(v)).not.toContain(SECRET_KEY)
	})

	it("places a location resolved on open, or a pending one, after the item's own fields", () => {
		const e = entry({ type: "fileUploaded", ...fileInfo({ parent: ARCHIVE }) })

		expect(rows(view(e), "item").some(row => row.key === "eventsFieldLocation")).toBe(false)
		expect(rows(view(e, { status: "resolved", uuid: ARCHIVE, name: "Archive" }), "item").at(-1)).toMatchObject({
			key: "eventsFieldLocation",
			value: "Archive",
			location: ARCHIVE
		})
		expect(rows(view(e, { status: "pending", uuid: ARCHIVE }), "item").at(-1)).toMatchObject({
			key: "eventsFieldLocation",
			pending: true
		})
	})

	it("names the kind from the name alone when the MIME type is missing", () => {
		const v = view(
			entry({ type: "fileUploaded", ...fileInfo({ metadata: { type: "decryptedUTF8", data: JSON.stringify({ name: "a.pdf" }) } }) })
		)

		expect(rows(v, "item").slice(0, 2)).toMatchObject([
			{ key: "eventsFieldName", value: "a.pdf" },
			{ key: "eventsFieldType", value: "PDF document" }
		])
	})

	it("merges a color change into one row with both swatches", () => {
		const v = view(
			entry({
				type: "folderColorChanged",
				...base,
				name: { type: "decoded", data: { name: "Photos" } },
				uuid: testUuid("dir"),
				color: "#112233",
				oldColor: "blue"
			})
		)
		const color = rows(v, "item").find(row => row.key === "eventsFieldColor")

		expect(rows(v, "item").some(row => row.key === "eventsFieldPreviousColor")).toBe(false)
		expect(color?.colors?.to).toEqual({ value: "Custom color", hex: "#112233", hint: "#112233" })
		expect(color?.colors?.from).toEqual({ value: "Blue", hex: "#037AFF" })
		expect(color?.value).toBe("Blue → Custom color (#112233)")
	})

	it("shows a share's contact with its avatar and copies the email", () => {
		const v = view(
			entry({
				type: "fileShared",
				...base,
				metadata: decodedFile("a.pdf"),
				uuid: FILE,
				parent: DOCUMENTS,
				receiverEmail: "anna@example.com"
			})
		)

		expect(rows(v, "item").find(row => row.key === "eventsFieldSharedWith")).toMatchObject({
			copy: "anna@example.com",
			contact: { email: "anna@example.com", name: "Anna", avatar: "https://example.com/a.png" }
		})
	})

	it("offers no copy of a name it can't decrypt", () => {
		const v = view(entry({ type: "fileUploaded", ...fileInfo({ metadata: { type: "encrypted", data: "x" } as unknown as FileMeta }) }))

		expect(rows(v, "item")[0]).toMatchObject({ value: "Encrypted" })
		expect(rows(v, "item")[0]?.copy).toBeUndefined()
		expect(rows(v, "item")[0]?.name).toBeUndefined()
	})

	it("isolates a name, revealing a misleading one's hidden characters while copying it as it is", () => {
		const plain = rows(view(entry({ type: "fileUploaded", ...fileInfo() })), "item")[0]
		const hostile = rows(
			view(entry({ type: "fileUploaded", ...fileInfo({ metadata: decodedFile("invoice\u202Efdp.exe") }) })),
			"item"
		)[0]

		expect(plain).toMatchObject({ key: "eventsFieldName", value: "report.pdf", name: true })
		expect(plain?.misleading).toBeUndefined()
		expect(hostile).toMatchObject({ value: "invoice⟨U+202E⟩fdp.exe", copy: "invoice\u202Efdp.exe", name: true, misleading: true })
	})

	it("reads an undecodable event's device, ids and raw JSON", () => {
		const raw = {
			id: 42,
			uuid: EVENT_UUID,
			type: "somethingNew",
			timestamp: 1_700_000_000,
			info: { ip: "198.51.100.1", userAgent: CHROME_MAC }
		}
		const unknown = selectEventsView([{ type: "err", message: "unknown variant", raw: JSON.stringify(raw) }]).entries[0]

		if (unknown === undefined) {
			throw new Error("no entry")
		}

		const v = view(unknown)

		expect(v.sections.map(section => section.key)).toEqual(["device", "details"])
		expect(rows(v, "details").map(row => [row.key, row.value])).toEqual([
			["eventsFieldEventType", "somethingNew"],
			["eventsFieldEventId", "42"],
			["eventsFieldEventUuid", EVENT_UUID]
		])
		expect(v.rawJson).toBe(JSON.stringify(raw, null, 2))
	})
})

describe("eventDetailText", () => {
	it("lists every shown row under its section, skipping a pending one", () => {
		const e = entry({ type: "fileUploaded", ...fileInfo({ parent: ARCHIVE }) })
		const text = eventDetailText("Uploaded report.pdf", "Tuesday", view(e, { status: "pending", uuid: ARCHIVE }))

		expect(text.startsWith("Uploaded report.pdf\nTuesday\n\nItem\nName: report.pdf\nType: PDF document (application/pdf)\n")).toBe(true)
		expect(text).toContain("\n\nDevice\nBrowser: Chrome 129.0.0.0\n")
		expect(text).toContain(`\n\nDetails\nEvent ID: 1\nEvent UUID: ${EVENT_UUID}\n`)
		expect(text).not.toContain("Location")
		expect(text).not.toContain(SECRET_KEY)
	})
})

describe("eventLocationUuid / eventLookupRef / eventHeroGlyph", () => {
	it("opens a real parent only, never a pseudo-parent", () => {
		// Typed as a uuid; the server's raw parent isn't checked.
		const trash = "trash" as UuidStr

		expect(eventLocationUuid(describeEvent(entry({ type: "fileUploaded", ...fileInfo() }), ctx))).toBe(DOCUMENTS)
		expect(eventLocationUuid(describeEvent(entry({ type: "fileUploaded", ...fileInfo({ parent: trash }) }), ctx))).toBeUndefined()
	})

	it("looks an item up only by an id it has", () => {
		expect(eventLookupRef(describeEvent(entry({ type: "fileUploaded", ...fileInfo({ uuid: undefined }) }), ctx))).toMatchObject({
			stableUuid: STABLE
		})
		expect(
			eventLookupRef(describeEvent(entry({ type: "fileUploaded", ...fileInfo({ uuid: undefined, stableUuid: undefined }) }), ctx))
		).toBeUndefined()
		expect(eventLookupRef(describeEvent(entry({ type: "login", ...base }), ctx))).toBeUndefined()
		// A delete of old versions names only the archived version, gone with it.
		expect(
			eventLookupRef(describeEvent(entry({ type: "deleteFilePermanently", ...fileInfo({ stableUuid: undefined }) }), ctx))
		).toBeUndefined()
		expect(eventLookupRef(describeEvent(entry({ type: "deleteFilePermanently", ...fileInfo() }), ctx))).toMatchObject({ uuid: FILE })
	})

	it("tells a deep-linked event the server doesn't have from a read that failed", () => {
		expect(eventLookupFailure({ species: "sdk", kind: "Server", label: "not found", message: "not found" })).toBe("notFound")
		expect(eventLookupFailure({ species: "sdk", kind: "Response", label: "x", message: "unknown variant" })).toBe("notFound")
		expect(eventLookupFailure({ species: "sdk", kind: "Reqwest", label: "x", message: "connection reset" })).toBe("error")
		expect(eventLookupFailure({ species: "sdk", kind: "Unauthenticated", label: "x", message: "x" })).toBe("error")
		expect(eventLookupFailure(new Error("Failed to fetch"))).toBe("error")
	})

	it("draws a file's type icon, a directory's color, else the action", () => {
		const file = entry({ type: "fileUploaded", ...fileInfo() })
		const dir = entry({
			type: "folderColorChanged",
			...base,
			name: { type: "decoded", data: { name: "P" } },
			uuid: testUuid("dir"),
			color: "red",
			oldColor: "blue"
		})
		const unsent = entry({
			type: "folderColorChanged",
			...base,
			name: { type: "decoded", data: { name: "P" } },
			uuid: testUuid("dir"),
			color: undefined as unknown as string,
			oldColor: "blue"
		})
		const login = entry({ type: "login", ...base })

		expect(eventHeroGlyph(file, describeEvent(file, ctx))).toEqual({ type: "file", iconKey: "pdf" })
		expect(eventHeroGlyph(dir, describeEvent(dir, ctx))).toEqual({ type: "directory", color: "red" })
		expect(eventHeroGlyph(unsent, describeEvent(unsent, ctx))).toEqual({ type: "directory", color: "default" })
		expect(eventHeroGlyph(login, describeEvent(login, ctx))).toEqual({ type: "action" })
	})
})
