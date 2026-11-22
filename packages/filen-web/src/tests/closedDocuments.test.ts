import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DocxEvent, DocxListener } from "@filen/office/dom/docx"
import type { PresentationEvent } from "@filen/office/dom/presentation"
import type { DriveItem } from "@/features/drive/lib/item"

// The engines the viewers use, as the closed-file readers drive them: no worker starts here.
const mocks = vi.hoisted(() => ({
	docxHost: vi.fn(),
	sessionClose: vi.fn(),
	openSheet: vi.fn(),
	connectPresentation: vi.fn(),
	openPdf: vi.fn()
}))

vi.mock("@/features/preview/lib/docxEngine", () => ({
	DOCX_FONT_URLS: {},
	docxHost: mocks.docxHost,
	docxLegacy: { open: vi.fn() },
	docxProtection: { open: vi.fn() },
	docxRtf: { open: vi.fn() }
}))
vi.mock("@filen/office/dom/docx", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/dom/docx")>()),
	docxPageText: (page: { sourceTexts: readonly string[] }) => page.sourceTexts.join("\n")
}))
vi.mock("@filen/office/dom/pdf", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/dom/pdf")>()),
	openPdf: mocks.openPdf
}))
vi.mock("@/features/preview/lib/pdfjsModule", () => ({ PDFJS: {} }))
vi.mock("@/features/preview/lib/pdfViewerSetup", () => ({ PDF_WORKER_SRC: "worker.js", pdfViewerSetup: () => ({ shared: {} }) }))
vi.mock("@/features/spreadsheet/lib/sheetHosts", () => ({ openSheet: mocks.openSheet }))
vi.mock("@/features/presentation/lib/presentationEngine", () => ({
	presentationPool: {},
	connectPresentation: mocks.connectPresentation
}))

const { ClosedDocumentRefusal, closedDocumentKind, openClosedDocument } = await import("@/features/preview/lib/closedDocuments")

function fileItem(name: string): DriveItem {
	const meta = { name, mime: "application/octet-stream", modified: 0n, size: 10n, key: "key", version: 2 }

	return {
		type: "file",
		data: {
			uuid: "00000001-0000-0000-0000-000000000000",
			stableUUID: undefined,
			parent: "00000000-0000-0000-0000-000000000000",
			size: 10n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 1_700_000_000_000n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: meta },
			undecryptable: false,
			decryptedMeta: meta
		}
	} as DriveItem
}

const signal = (): AbortSignal => new AbortController().signal
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

beforeEach(() => {
	vi.clearAllMocks()
})

describe("which engine reads a closed file", () => {
	it.each([
		["report.pdf", "pdf"],
		["letter.docx", "docx"],
		["letter.odt", "docx"],
		["old.doc", "docx"],
		["notes.rtf", "docx"],
		["budget.xlsx", "sheet"],
		["budget.ods", "sheet"],
		["legacy.xls", "sheet"],
		["deck.pptx", "slides"],
		["deck.odp", "slides"],
		["data.csv", null],
		["data.tsv", null],
		["readme.txt", null],
		["photo.jpg", null]
	])("%s → %s", (name, kind) => {
		expect(closedDocumentKind(fileItem(name))).toBe(kind)
	})

	it.each(["deck.ppt", "show.pps", "talk.key", "essay.pages", "sums.numbers", "book.epub"])("refuses %s with a reason", name => {
		const kind = closedDocumentKind(fileItem(name))

		expect(kind).toEqual({ refused: expect.stringContaining(`"${name}"`) as unknown })
	})
})

describe("a closed Word document", () => {
	function page(index: number, text: string) {
		return { index, sourceTexts: [text] }
	}

	it("lays it out once, keeps each page's text, and closes the engine", async () => {
		mocks.docxHost.mockImplementation((_source: unknown, listener: DocxListener) => {
			queueMicrotask(() => {
				listener({ type: "pages", pages: [page(0, "one")], final: false, pageCount: 0 } as unknown as DocxEvent)
				listener({ type: "pages", pages: [page(1, "two"), page(2, "three")], final: true, pageCount: 3 } as unknown as DocxEvent)
			})

			return { close: mocks.sessionClose }
		})

		const opened = await openClosedDocument(fileItem("a.docx"), ZIP, "docx", signal())

		expect(mocks.sessionClose).toHaveBeenCalledTimes(1)
		expect(await opened.reader.units()).toBe(3)
		expect(await opened.reader.text({ from: 2, to: 9 }, signal(), 1000)).toEqual({
			text: "two\n\nthree",
			units: [
				{ label: "page 2", start: 0 },
				{ label: "page 3", start: 5 }
			],
			truncated: false
		})
	})

	it("refuses a document the engine cannot open, and one behind a password", async () => {
		for (const reason of ["needsPassword", "malformed"]) {
			mocks.docxHost.mockImplementationOnce((_source: unknown, listener: DocxListener) => {
				queueMicrotask(() => {
					listener({ type: "error", reason, message: "" } as DocxEvent)
				})

				return { close: mocks.sessionClose }
			})

			await expect(openClosedDocument(fileItem("a.docx"), ZIP, "docx", signal())).rejects.toBeInstanceOf(ClosedDocumentRefusal)
		}

		expect(mocks.sessionClose).toHaveBeenCalledTimes(2)
	})

	it("closes the engine when the read is stopped", async () => {
		mocks.docxHost.mockReturnValue({ close: mocks.sessionClose })

		const controller = new AbortController()
		const opening = openClosedDocument(fileItem("a.docx"), ZIP, "docx", controller.signal)

		await Promise.resolve()
		controller.abort()

		await expect(opening).rejects.toThrow()
		expect(mocks.sessionClose).toHaveBeenCalled()
	})
})

describe("a closed workbook", () => {
	it("reads the visible sheets through the session's text query and gives their names", async () => {
		const query = vi.fn(() => Promise.resolve({ text: "a\tb", truncated: false }))
		const close = vi.fn()
		const bytes = ZIP.slice()

		mocks.openSheet.mockResolvedValue({
			kind: "opened",
			session: { query, close },
			info: {
				sheets: [
					{ id: 1, name: "Data", state: "visible", kind: "worksheet" },
					{ id: 2, name: "Secret", state: "veryHidden", kind: "worksheet" },
					{ id: 3, name: "Totals", state: "hidden", kind: "worksheet" }
				]
			}
		})

		const opened = await openClosedDocument(fileItem("b.xlsx"), bytes, "sheet", signal())

		// The worker gets a copy: the caller's buffer may be the preview cache's.
		expect(mocks.openSheet.mock.calls[0]?.[0]).not.toBe(bytes)
		expect(opened.sheets).toEqual(["Data", "Totals"])
		expect(await opened.reader.units()).toBe(2)
		expect((await opened.reader.text({ from: 2, to: 2 }, signal(), 100)).units).toEqual([{ label: "Totals", start: 0 }])
		opened.close()
		expect(close).toHaveBeenCalled()
	})

	it("refuses a password-protected workbook and lets go of it", async () => {
		const dispose = vi.fn()

		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked: { dispose } })

		await expect(openClosedDocument(fileItem("b.xlsx"), ZIP, "sheet", signal())).rejects.toBeInstanceOf(ClosedDocumentRefusal)
		expect(dispose).toHaveBeenCalled()
	})
})

describe("a closed deck", () => {
	it("opens it without rendering and reads its slides", async () => {
		const dispose = vi.fn()
		const text = vi.fn(() => Promise.resolve({ slides: [{ index: 0, text: "Hello", notes: "" }], truncated: false }))

		mocks.connectPresentation.mockImplementation(
			(_pool: unknown, _source: unknown, listener: (event: PresentationEvent) => void, options: Record<string, unknown>) => {
				expect(options["window"]).toBeUndefined()
				queueMicrotask(() => {
					listener({ type: "opened", info: { slides: [{}, {}] } } as unknown as PresentationEvent)
				})

				return { session: { text }, dispose }
			}
		)

		const opened = await openClosedDocument(fileItem("c.pptx"), ZIP, "slides", signal())

		expect(await opened.reader.units()).toBe(2)
		expect((await opened.reader.text({ from: 1, to: 1 }, signal(), 100)).text).toBe("Hello")
		opened.close()
		expect(dispose).toHaveBeenCalled()
	})

	it("refuses an encrypted deck", async () => {
		const dispose = vi.fn()

		mocks.connectPresentation.mockImplementation((_pool: unknown, _source: unknown, listener: (event: PresentationEvent) => void) => {
			queueMicrotask(() => {
				listener({ type: "error", reason: "needsPassword", message: "" })
			})

			return { session: {}, dispose }
		})

		await expect(openClosedDocument(fileItem("c.pptx"), ZIP, "slides", signal())).rejects.toBeInstanceOf(ClosedDocumentRefusal)
		expect(dispose).toHaveBeenCalled()
	})
})

describe("a closed PDF", () => {
	it("reads page text and destroys the document on close", async () => {
		const destroy = vi.fn(() => Promise.resolve())
		const cleanup = vi.fn()
		const document = {
			numPages: 2,
			getPage: (number: number) =>
				Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: `p${String(number)}` }] }), cleanup })
		}

		mocks.openPdf.mockReturnValue({ promise: Promise.resolve(document), destroy, password: () => false })

		const opened = await openClosedDocument(fileItem("d.pdf"), ZIP, "pdf", signal())

		expect(await opened.reader.units()).toBe(2)
		expect((await opened.reader.text({ from: 1, to: 2 }, signal(), 100)).text).toBe("p1\n\np2")
		expect(cleanup).toHaveBeenCalledTimes(2)
		opened.close()
		expect(destroy).toHaveBeenCalled()
	})

	it("refuses a password-protected PDF", async () => {
		const destroy = vi.fn(() => Promise.resolve())

		mocks.openPdf.mockImplementation((_pdfjs: unknown, _source: unknown, options: { onPassword: (reason: string) => void }) => {
			queueMicrotask(() => {
				options.onPassword("needsPassword")
			})

			return { promise: new Promise(() => undefined), destroy, password: () => false }
		})

		await expect(openClosedDocument(fileItem("d.pdf"), ZIP, "pdf", signal())).rejects.toBeInstanceOf(ClosedDocumentRefusal)
		expect(destroy).toHaveBeenCalled()
	})
})
