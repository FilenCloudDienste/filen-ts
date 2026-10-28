import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { PREVIEW_MAX_BYTES, SPREADSHEET_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import { mockSharedFile } from "@/tests/fixtures/sdk"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { DOWNLOAD_AS_TARGETS, canDownloadAs, downloadAsSource, downloadAsTargets } from "@/features/drive/lib/downloadAs.logic"
import { applyOfflineGate, driveItemActions } from "@/features/drive/components/itemMenu.logic"
import { driveBulkActions, isBulkActionOfflineDisabled } from "@/features/drive/components/bulkActionBar.logic"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { previewMenuHiddenActionIds } from "@/features/preview/components/previewOverlay.logic"

// Where Download as is offered: every format the document and spreadsheet viewers open, wherever Download is
// offered, never past the viewer's own size cap; in bulk only when every selected file qualifies.

function file(name: string, size = 1_024n, overrides: Partial<File> = {}): DriveItem {
	return narrowItem({
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size, key: "key", version: 2 }
		},
		...overrides
	} satisfies File)
}

function directory(name: string): DriveItem {
	return narrowItem({
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

const DOCUMENTS = ["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "ott", "rtf"]
const SPREADSHEETS = ["xlsx", "xlsm", "xltx", "xltm", "xls", "xlt", "ods", "ots", "csv", "tsv", "tab"]

function ids(item: DriveItem, variant: DriveVariant): string[] {
	return driveItemActions(item, variant).map(descriptor => descriptor.id)
}

describe("downloadAsSource", () => {
	it("exports every format the document viewer opens from the document engine", () => {
		for (const extension of DOCUMENTS) {
			expect(downloadAsSource(file(`report.${extension}`)), extension).toBe("document")
		}
	})

	it("exports every format the spreadsheet viewer opens from the spreadsheet engine", () => {
		for (const extension of SPREADSHEETS) {
			expect(downloadAsSource(file(`book.${extension}`)), extension).toBe("spreadsheet")
		}
	})

	it("exports nothing else: other files, directories, undecryptable files", () => {
		for (const name of ["photo.jpg", "notes.txt", "paper.pdf", "deck.key", "archive.zip", "book.xlsb", "data.numbers"]) {
			expect(downloadAsSource(file(name)), name).toBeNull()
		}

		expect(downloadAsSource(directory("Reports.docx"))).toBeNull()
		expect(downloadAsSource(file("report.docx", 1_024n, { meta: { type: "encrypted", data: "ciphertext" } }))).toBeNull()
	})

	it("stops at the viewer's size cap: a file the viewer would not load is never loaded for an export", () => {
		expect(downloadAsSource(file("report.docx", PREVIEW_MAX_BYTES))).toBe("document")
		expect(downloadAsSource(file("report.docx", PREVIEW_MAX_BYTES + 1n))).toBeNull()
		expect(downloadAsSource(file("book.xlsx", SPREADSHEET_MAX_BYTES))).toBe("spreadsheet")
		expect(downloadAsSource(file("book.xlsx", SPREADSHEET_MAX_BYTES + 1n))).toBeNull()
		expect(downloadAsSource(file("book.csv", SPREADSHEET_MAX_BYTES + 1n))).toBeNull()
	})
})

describe("downloadAsTargets", () => {
	it("offers PDF for documents, spreadsheets and a mix of both", () => {
		expect(downloadAsTargets([file("a.docx")])[0]).toEqual(["pdf"])
		expect(downloadAsTargets([file("a.ods")])[0]).toEqual(["pdf"])
		expect(downloadAsTargets([file("a.rtf"), file("b.xls")])).toEqual([["pdf"]])
	})

	it("offers the editable formats a document converts to after the PDF, never the file's own", () => {
		for (const extension of ["docx", "docm", "dotx", "dotm"])
			expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["odt"]])
		for (const extension of ["odt", "ott"]) expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["docx"]])
		for (const extension of ["rtf", "doc", "dot"])
			expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["docx", "odt"]])
	})

	it("offers the editable formats a spreadsheet converts to after the PDF, never the file's own", () => {
		for (const extension of ["xlsx", "xlsm", "xltx", "xltm"])
			expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["ods"]])
		for (const extension of ["ods", "ots"]) expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["xlsx"]])
		for (const extension of ["xls", "xlt", "csv", "tsv", "tab"])
			expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["xlsx", "ods"]])
	})

	it("offers in bulk only the formats every file converts to and none is already in", () => {
		expect(downloadAsTargets([file("a.docx"), file("b.rtf")])).toEqual([["pdf"], ["odt"]])
		expect(downloadAsTargets([file("a.docx"), file("b.odt")])).toEqual([["pdf"]])
		expect(downloadAsTargets([file("a.xls"), file("b.csv")])).toEqual([["pdf"], ["xlsx", "ods"]])
		expect(downloadAsTargets([file("a.docx"), file("b.ods")])).toEqual([["pdf"]])
	})

	it("names each target's download by its own extension", () => {
		expect(Object.fromEntries(Object.entries(DOWNLOAD_AS_TARGETS).map(([target, def]) => [target, def.extension]))).toEqual({
			pdf: "pdf",
			docx: "docx",
			odt: "odt",
			xlsx: "xlsx",
			ods: "ods",
			pptx: "pptx",
			odp: "odp"
		})
	})

	it("offers nothing when any item exports to nothing, or for no items", () => {
		expect(downloadAsTargets([file("a.docx"), file("b.png")])).toEqual([])
		expect(downloadAsTargets([file("a.docx"), directory("d")])).toEqual([])
		expect(downloadAsTargets([])).toEqual([])
		expect(canDownloadAs([])).toBe(false)
	})
})

describe("Download as in the item menu", () => {
	it("sits right after Download for an exportable file, on every surface that offers Download", () => {
		for (const variant of ["drive", "recents", "favorites", "links", "sharedIn", "sharedOut"] as const) {
			const list = ids(file("report.docx"), variant)

			expect(list.indexOf("downloadAs"), variant).toBe(list.indexOf("download") + 1)
		}

		const shared = narrowItem(
			mockSharedFile({
				meta: { type: "decoded", data: { name: "book.xlsx", mime: "", modified: 0n, size: 2_048n, key: "k", version: 2 } }
			})
		)

		expect(ids(shared, "sharedIn")).toContain("downloadAs")
	})

	it("is never offered in the trash, for an undecryptable file, for a file it cannot export or past the size cap", () => {
		expect(ids(file("report.docx"), "trash")).not.toContain("downloadAs")
		expect(ids(file("report.docx", 1_024n, { meta: { type: "encrypted", data: "ciphertext" } }), "drive")).not.toContain("downloadAs")
		expect(ids(file("photo.jpg"), "drive")).not.toContain("downloadAs")
		expect(ids(file("report.docx", PREVIEW_MAX_BYTES + 1n), "drive")).not.toContain("downloadAs")
		expect(ids(directory("Reports"), "drive")).not.toContain("downloadAs")
	})

	it("is disabled offline, as Download is", () => {
		const offline = applyOfflineGate(driveItemActions(file("report.docx"), "drive"), false)

		expect(offline.find(descriptor => descriptor.id === "downloadAs")?.enabled).toBe(false)
		expect(offline.find(descriptor => descriptor.id === "download")?.enabled).toBe(false)
	})

	it("is left out of the preview header's menu where the file may not be downloaded (a link with downloads off, the trash)", () => {
		expect(previewMenuHiddenActionIds(undefined, true).has("downloadAs")).toBe(false)
		expect(previewMenuHiddenActionIds(undefined, false).has("downloadAs")).toBe(true)
	})
})

describe("Download as in the bulk menus", () => {
	it("is offered after Download when every selected file exports", () => {
		const list = driveBulkActions("drive", aggregateDriveSelectionFlags([file("a.docx"), file("b.xlsx"), file("c.rtf")])).map(
			descriptor => descriptor.id
		)

		expect(list.indexOf("downloadAs")).toBe(list.indexOf("download") + 1)
	})

	it("is not offered for a selection holding anything else, in the trash, or with an undecryptable item", () => {
		expect(driveBulkActions("drive", aggregateDriveSelectionFlags([file("a.docx"), file("b.png")])).map(d => d.id)).not.toContain(
			"downloadAs"
		)
		expect(driveBulkActions("trash", aggregateDriveSelectionFlags([file("a.docx"), file("b.docx")])).map(d => d.id)).not.toContain(
			"downloadAs"
		)
		expect(
			driveBulkActions(
				"drive",
				aggregateDriveSelectionFlags([file("a.docx"), file("b.docx", 1_024n, { meta: { type: "encrypted", data: "ciphertext" } })])
			).map(d => d.id)
		).not.toContain("downloadAs")
	})

	it("is disabled offline", () => {
		expect(isBulkActionOfflineDisabled("downloadAs", false)).toBe(true)
		expect(isBulkActionOfflineDisabled("downloadAs", true)).toBe(false)
	})
})
