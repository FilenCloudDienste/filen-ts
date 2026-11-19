// @vitest-environment jsdom

import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import type { File as SdkFile } from "@filen/sdk-rs"

// The overlay's PreviewBody and the read-only body (public links, archive entries) mount the same viewer for every
// category that is no container: the overlay only adds editing props, never another viewer.

vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})

const { stub } = vi.hoisted(() => ({
	stub: (name: string) => () => createElement("div", { "data-viewer": name })
}))

vi.mock("@/features/preview/components/imageViewer", () => ({ ImageViewer: stub("ImageViewer"), RawImageViewer: stub("RawImageViewer") }))
vi.mock("@/features/preview/components/mediaViewer", () => ({ MediaViewer: stub("MediaViewer") }))
vi.mock("@/features/preview/components/docxViewer", () => ({ DocxViewer: stub("DocxViewer") }))
vi.mock("@/features/preview/components/markdownViewer", () => ({ MarkdownViewer: stub("MarkdownViewer") }))
vi.mock("@/features/preview/components/pdfViewer", () => ({ PdfViewer: stub("PdfViewer") }))
vi.mock("@/features/preview/components/ebookViewer", () => ({ EbookViewer: stub("EbookViewer") }))
vi.mock("@/features/preview/components/textViewer", () => ({ TextViewer: stub("TextViewer") }))
vi.mock("@/features/preview/components/largeTextViewer", () => ({ LargeTextViewer: stub("LargeTextViewer") }))
vi.mock("@/features/preview/components/fontViewer", () => ({ FontViewer: stub("FontViewer") }))
vi.mock("@/features/preview/components/torrentViewer", () => ({ TorrentViewer: stub("TorrentViewer") }))
vi.mock("@/features/preview/components/emailViewer", () => ({ EmailViewer: stub("EmailViewer") }))
vi.mock("@/features/preview/components/mailboxViewer", () => ({ MailboxViewer: stub("MailboxViewer") }))
vi.mock("@/features/preview/components/subtitleViewer", () => ({ SubtitleViewer: stub("SubtitleViewer") }))
vi.mock("@/features/preview/components/calendarViewer", () => ({ CalendarViewer: stub("CalendarViewer") }))
vi.mock("@/features/preview/components/notebookViewer", () => ({ NotebookViewer: stub("NotebookViewer") }))
vi.mock("@/features/preview/components/contactViewer", () => ({ ContactViewer: stub("ContactViewer") }))
vi.mock("@/features/preview/components/mermaidViewer", () => ({ MermaidViewer: stub("MermaidViewer") }))
vi.mock("@/features/preview/components/binaryInfoViewer", () => ({ BinaryInfoViewer: stub("BinaryInfoViewer") }))
vi.mock("@/features/preview/components/sqliteViewer", () => ({ SqliteViewer: stub("SqliteViewer") }))
vi.mock("@/features/preview/components/geoViewer", () => ({ GeoViewer: stub("GeoViewer") }))
vi.mock("@/features/preview/components/model3dViewer", () => ({ Model3dViewer: stub("Model3dViewer") }))
vi.mock("@/features/preview/components/dxfViewer", () => ({ DxfViewer: stub("DxfViewer") }))
vi.mock("@/features/preview/components/dicomViewer", () => ({ DicomViewer: stub("DicomViewer") }))
vi.mock("@/features/spreadsheet/sheetViewer", () => ({ SheetViewer: stub("SheetViewer") }))
vi.mock("@/features/presentation/components/presentationViewer", () => ({ PresentationViewer: stub("PresentationViewer") }))
vi.mock("@/features/archive/components/archiveBrowser", () => ({ ArchiveBrowser: stub("ArchiveBrowser") }))
vi.mock("@/features/comics/components/comicViewer", () => ({ ComicViewer: stub("ComicViewer") }))
vi.mock("@/features/iwork/components/iworkPreview", () => ({ IworkPreview: stub("IworkPreview") }))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { CATEGORY_POLICY, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { PreviewBody } from "@/features/preview/components/previewBody"
import { ReadOnlyPreviewBody } from "@/features/preview/components/readOnlyPreviewBody"

// Shown by their hosts outside the overlay (an archive's browser, a comic's reader, an iWork package's own preview).
const CONTAINERS: ReadonlySet<PreviewCategory> = new Set(["archive", "comic", "iwork", "other"])

const file: SdkFile = {
	uuid: "11111111-1111-1111-1111-111111111111",
	stableUUID: undefined,
	parent: "22222222-2222-2222-2222-222222222222",
	size: 16n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 1_700_000_000_000n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "file", mime: "", modified: 1_700_000_000_000n, size: 16n, key: "key", version: 2 } }
}
const item = narrowItem(file)

function viewer(): string | null {
	return document.querySelector("[data-viewer]")?.getAttribute("data-viewer") ?? null
}

afterEach(() => {
	cleanup()
})

describe("PreviewBody and ReadOnlyPreviewBody", () => {
	it.each((Object.keys(CATEGORY_POLICY) as PreviewCategory[]).filter(category => !CONTAINERS.has(category)))(
		"mount the same viewer for %s",
		category => {
			render(
				createElement(PreviewBody, {
					item,
					variant: "drive",
					category,
					documentKey: "doc",
					editable: true,
					renamedReadOnly: false,
					neverEditable: false,
					locked: false,
					onDirtyChange: vi.fn(),
					onTextState: vi.fn(),
					readAs: null,
					contentRef: { current: null },
					spreadsheetRef: { current: null },
					docxRef: { current: null },
					presentationRef: { current: null },
					imageRef: { current: null },
					imagePageRef: { current: null },
					onSave: () => false,
					onAutosave: () => false,
					onOpenFile: vi.fn(),
					canSaveCopy: false
				})
			)

			const overlay = viewer()

			cleanup()
			render(createElement(ReadOnlyPreviewBody, { item, category, alt: "file" }))

			expect(overlay).not.toBeNull()
			expect(viewer()).toBe(overlay)
		}
	)

	it("leaves the containers to their hosts read-only", () => {
		for (const category of CONTAINERS) {
			render(createElement(ReadOnlyPreviewBody, { item, category, alt: "file" }))
			expect(viewer()).toBeNull()
			cleanup()
		}
	})
})
