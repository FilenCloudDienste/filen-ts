// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import {
	canCopyToClipboard,
	canCutToClipboard,
	canPaste,
	shouldHandleClipboardShortcut,
	type PasteTarget
} from "@/features/drive/lib/clipboard.logic"
import { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboardStore"

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

function target(overrides: Partial<PasteTarget> = {}): PasteTarget {
	return { variant: "drive", uuid: testUuid("dest"), ancestry: [testUuid("dest")], listing: [], online: true, ...overrides }
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
