// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import type { Dir, File, SharedRootDir, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import {
	canCopyToClipboard,
	canCutToClipboard,
	canPaste,
	canPasteIntoDirectory,
	shouldHandleClipboardShortcut,
	type DirectoryPasteTarget,
	type PasteTarget
} from "@/features/drive/lib/clipboard.logic"
import { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboardStore"
import { type ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: testUuid(parent),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	} satisfies Dir)
}

function fileItem(label: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid(parent),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${label}.txt`, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 }
		}
	} satisfies File)
}

const UNDECRYPTABLE = narrowItem({
	uuid: testUuid("secret"),
	parent: testUuid("home"),
	color: "default",
	timestamp: 0n,
	favorited: false,
	meta: { type: "encrypted", data: "cipher" }
} satisfies Dir)

const DOCS = dirItem("docs", "home")
const REPORT = fileItem("report", "home")
const NOTES = fileItem("notes", "docs")

// home > docs > inner, and dest at the root.
const PARENTS = new Map<string, string | null>([
	[testUuid("home"), null],
	[testUuid("dest"), null],
	[testUuid("docs"), testUuid("home")],
	[testUuid("inner"), testUuid("docs")]
])

function parentsFrom(map: ReadonlyMap<string, string | null>): () => ParentLookup {
	return () => uuid => map.get(uuid)
}

function target(overrides: Partial<PasteTarget> = {}): PasteTarget {
	return {
		variant: "drive",
		uuid: testUuid("dest"),
		ancestry: [testUuid("dest")],
		readParents: parentsFrom(PARENTS),
		listing: [],
		online: true,
		...overrides
	}
}

const COPY: DriveClipboardEntry = { mode: "copy", items: [DOCS, REPORT] }
const CUT: DriveClipboardEntry = { mode: "cut", items: [DOCS, REPORT] }

describe("canCopyToClipboard / canCutToClipboard", () => {
	const EVERY_VARIANT: DriveVariant[] = ["drive", "recents", "favorites", "trash", "links", "sharedIn", "sharedOut"]

	it("copies from every listing but the trash, cuts only where Move is offered", () => {
		const copyable = EVERY_VARIANT.filter(variant => canCopyToClipboard([REPORT], variant))
		const cuttable = EVERY_VARIANT.filter(variant => canCutToClipboard([REPORT], variant))

		expect(copyable).toEqual(["drive", "recents", "favorites", "links", "sharedIn", "sharedOut"])
		expect(cuttable).toEqual(["drive", "recents", "favorites", "sharedOut"])
	})

	it("refuses an empty selection and any undecryptable item", () => {
		expect(canCopyToClipboard([], "drive")).toBe(false)
		expect(canCopyToClipboard([REPORT, UNDECRYPTABLE], "drive")).toBe(false)
		expect(canCutToClipboard([UNDECRYPTABLE], "drive")).toBe(false)
	})
})

describe("canPaste", () => {
	it("needs something copied, a connection and the directory's listing", () => {
		expect(canPaste(COPY, target())).toBe(true)
		expect(canPaste(null, target())).toBe(false)
		expect(canPaste({ mode: "copy", items: [] }, target())).toBe(false)
		expect(canPaste(COPY, target({ online: false }))).toBe(false)
		expect(canPaste(COPY, target({ listing: undefined }))).toBe(false)
	})

	it("pastes only where the listing can be written to", () => {
		expect(canPaste(COPY, target({ uuid: null, ancestry: [] }))).toBe(true)
		expect(canPaste(COPY, target({ variant: "sharedOut" }))).toBe(true)
		expect(canPaste(COPY, target({ variant: "sharedOut", uuid: null, ancestry: [] }))).toBe(false)

		for (const variant of ["recents", "favorites", "trash", "links", "sharedIn"] as const) {
			expect(canPaste(COPY, target({ variant }))).toBe(false)
		}
	})

	it("refuses a copied or cut directory as its own destination or below it", () => {
		const insideDocs = target({ uuid: testUuid("inner"), ancestry: [testUuid("docs"), testUuid("inner")] })

		expect(canPaste(COPY, target({ uuid: testUuid("docs"), ancestry: [testUuid("docs")] }))).toBe(false)
		expect(canPaste(COPY, insideDocs)).toBe(false)
		expect(canPaste(CUT, insideDocs)).toBe(false)
	})

	it("refuses a directory cut or copied from Shared by me as its own destination or below it", () => {
		const sharedDocs = narrowItem({
			inner: { uuid: testUuid("docs"), color: "default", timestamp: 0n, meta: { type: "decoded", data: { name: "docs" } } },
			sharingRole: { Receiver: { email: "friend@filen.io", id: 7 } },
			writeAccess: true
		} satisfies SharedRootDir)
		const insideDocs = target({ uuid: testUuid("inner"), ancestry: [testUuid("docs"), testUuid("inner")] })

		expect(canPaste({ mode: "cut", items: [sharedDocs] }, insideDocs)).toBe(false)
		expect(canPaste({ mode: "copy", items: [sharedDocs] }, target({ uuid: testUuid("docs"), ancestry: [testUuid("docs")] }))).toBe(
			false
		)
	})

	// Search, Favorites, Recents, Links and a pasted address all open a directory on a route that starts
	// at it, so its route chain names none of the directories above it.
	it("walks the real chain of a directory opened on a fresh route", () => {
		const openedFromSearch = target({ uuid: testUuid("inner"), ancestry: [testUuid("inner")] })

		expect(canPaste(COPY, openedFromSearch)).toBe(false)
		expect(canPaste(CUT, openedFromSearch)).toBe(false)
		expect(canPaste({ mode: "copy", items: [REPORT] }, openedFromSearch)).toBe(true)
	})

	it("refuses a directory where the chain can't be resolved, and still pastes files there", () => {
		const unknownChain = target({ uuid: testUuid("far"), ancestry: [testUuid("far")] })

		expect(canPaste(COPY, unknownChain)).toBe(false)
		expect(canPaste({ mode: "copy", items: [REPORT] }, unknownChain)).toBe(true)
	})

	// Someone else's directory can never hold one of the user's own, however little of the chain is known.
	it("pastes a directory copied from Shared with me where the chain can't be resolved", () => {
		const received = narrowItem({
			inner: { uuid: testUuid("received"), color: "default", timestamp: 0n, meta: { type: "decoded", data: { name: "received" } } },
			sharingRole: { Sharer: { email: "owner@filen.io", id: 9 } },
			writeAccess: false
		} satisfies SharedRootDir)

		expect(canPaste({ mode: "copy", items: [received] }, target({ uuid: testUuid("far"), ancestry: [testUuid("far")] }))).toBe(true)
	})

	it("reads the parents only while a directory is on the clipboard", () => {
		const readParents = vi.fn(parentsFrom(PARENTS))

		canPaste({ mode: "copy", items: [REPORT] }, target({ readParents }))
		expect(readParents).not.toHaveBeenCalled()

		expect(canPaste(COPY, target({ readParents }))).toBe(true)
		expect(readParents).toHaveBeenCalledOnce()
	})

	it("copies beside the source, but moves a cut only somewhere else in My Drive", () => {
		const home = target({ uuid: testUuid("home"), ancestry: [testUuid("home")], listing: [DOCS, REPORT] })

		expect(canPaste(COPY, home)).toBe(true)
		expect(canPaste(CUT, home)).toBe(false)
		expect(canPaste(CUT, target())).toBe(true)
		expect(canPaste(CUT, target({ variant: "sharedOut" }))).toBe(false)
		// Only part of the cut sits here already: the rest still moves.
		expect(canPaste({ mode: "cut", items: [REPORT, NOTES] }, home)).toBe(true)
	})
})

// A sidebar tree node: its listing is only there when something has read it.
describe("canPasteIntoDirectory", () => {
	function directory(overrides: Partial<DirectoryPasteTarget> = {}): DirectoryPasteTarget {
		return { ...target(), listing: undefined, parentUuid: testUuid("dest"), ...overrides }
	}

	const home = { uuid: testUuid("home"), ancestry: [testUuid("home")], parentUuid: testUuid("home") }

	it("copies into a directory whose listing was never read", () => {
		expect(canPasteIntoDirectory(COPY, directory())).toBe(true)
		expect(canPaste(COPY, target({ listing: undefined }))).toBe(false)
	})

	it("judges a cut's no-op by the items' own parents without a listing, and by the listing with one", () => {
		expect(canPasteIntoDirectory(CUT, directory(home))).toBe(false)
		expect(canPasteIntoDirectory({ mode: "cut", items: [REPORT, NOTES] }, directory(home))).toBe(true)
		expect(canPasteIntoDirectory(CUT, directory())).toBe(true)
		// A listing, when cached, is what the no-op is read from.
		expect(canPasteIntoDirectory(CUT, directory({ ...home, listing: [] }))).toBe(true)
		expect(canPasteIntoDirectory(CUT, directory({ listing: [DOCS, REPORT] }))).toBe(false)
	})

	it("keeps canPaste's other rules: online, writable, never into a copied or cut directory or below it", () => {
		expect(canPasteIntoDirectory(null, directory())).toBe(false)
		expect(canPasteIntoDirectory(COPY, directory({ online: false }))).toBe(false)
		expect(canPasteIntoDirectory(COPY, directory({ variant: "trash" }))).toBe(false)
		expect(canPasteIntoDirectory(COPY, directory({ uuid: testUuid("docs"), ancestry: [testUuid("docs")] }))).toBe(false)
		expect(canPasteIntoDirectory(CUT, directory({ uuid: testUuid("inner"), ancestry: [testUuid("docs"), testUuid("inner")] }))).toBe(
			false
		)
		expect(canPasteIntoDirectory(COPY, directory({ uuid: null, ancestry: [], parentUuid: testUuid("root") }))).toBe(true)
	})
})

describe("shouldHandleClipboardShortcut", () => {
	const idle = { overlayOpen: false, textSelected: false }

	it("claims the keys over the listing", () => {
		const row = document.createElement("div")
		row.setAttribute("role", "option")

		expect(shouldHandleClipboardShortcut({ target: row, ...idle })).toBe(true)
		expect(shouldHandleClipboardShortcut({ target: document.body, ...idle })).toBe(true)
	})

	it("leaves text fields, open overlays and selected text to the browser", () => {
		// jsdom has no isContentEditable of its own.
		const editable = document.createElement("div")
		Object.defineProperty(editable, "isContentEditable", { value: true })

		for (const field of [document.createElement("input"), document.createElement("textarea"), document.createElement("select")]) {
			expect(shouldHandleClipboardShortcut({ target: field, ...idle })).toBe(false)
		}

		expect(shouldHandleClipboardShortcut({ target: editable, ...idle })).toBe(false)
		expect(shouldHandleClipboardShortcut({ target: document.body, overlayOpen: true, textSelected: false })).toBe(false)
		expect(shouldHandleClipboardShortcut({ target: document.body, overlayOpen: false, textSelected: true })).toBe(false)
	})
})
