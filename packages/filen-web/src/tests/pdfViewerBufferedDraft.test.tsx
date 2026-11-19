// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PdfSource } from "@filen/office/dom/pdf"

// The PDF viewer's buffered source and its extracted-pages draft: a signed version's view of the bytes stays one
// source across a metadata-only re-render (pdf.js would reopen on a new one), and a draft whose save runs is neither
// closed by Escape nor discarded by a question asked before the save started.

const harness = vi.hoisted(() => ({
	bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
	sources: [] as PdfSource[],
	saving: false
}))

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	PDFDataRangeTransport: vi.fn(),
	TextLayer: vi.fn(),
	getDocument: () => ({ promise: new Promise(() => undefined), destroy: () => Promise.resolve() })
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: harness.bytes, refetch: () => undefined })
}))

vi.mock("@filen/office/react/pdf", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/pdf")>()),
	// Never opens: the viewer stays on its loading state, the source it was given recorded.
	usePdfDocument: (_pdfjs: unknown, source: PdfSource) => {
		harness.sources.push(source)

		return {
			state: { status: "loading" },
			password: () => undefined,
			retry: () => undefined,
			fullyRead: false,
			resident: false,
			reopen: () => undefined,
			acceptedPassword: () => null,
			release: () => undefined
		}
	}
}))

vi.mock("@/features/pdf/session/usePdfEdit", () => ({
	usePdfEdit: () => ({
		phase: { kind: "failed" },
		snapshot: null,
		swap: { retry: () => undefined },
		history: {
			canUndo: false,
			canRedo: false,
			saving: harness.saving,
			canSave: !harness.saving,
			save: () => undefined
		}
	})
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { BufferedPdf, PdfDraftDocument } from "@/features/preview/components/pdfViewer"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PdfDraft, PdfPagesController } from "@/features/pdf/pages/pagesController"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"

registerAllActions()

function item(favorited: boolean): DriveItem {
	return {
		type: "file",
		data: {
			uuid: "11111111-1111-1111-1111-111111111111",
			parent: "22222222-2222-2222-2222-222222222222",
			size: 8n,
			favorited,
			decryptedMeta: { name: "report.pdf", mime: "application/pdf", size: 8n }
		}
	} as unknown as DriveItem
}

afterEach(() => {
	cleanup()
	harness.sources = []
	harness.saving = false
})

describe("BufferedPdf", () => {
	it("keeps the signed version's source across a re-render with a new item for the same file", () => {
		const signatures = { kind: "signedVersion", onBack: () => undefined } as const
		const view = render(
			<BufferedPdf
				item={item(false)}
				alt="report.pdf"
				limit={4}
				signatures={signatures}
				edit={null}
				notice={null}
			/>
		)

		view.rerender(
			<BufferedPdf
				item={item(true)}
				alt="report.pdf"
				limit={4}
				signatures={signatures}
				edit={null}
				notice={null}
			/>
		)

		const [first, last] = [harness.sources[0], harness.sources.at(-1)]

		expect(harness.sources.length).toBeGreaterThan(1)
		expect(first?.kind === "bytes" ? first.bytes.byteLength : null).toBe(4)
		expect(last?.kind === "bytes" && first?.kind === "bytes" ? last.bytes === first.bytes : false).toBe(true)
	})
})

describe("PdfDraftDocument", () => {
	const draft = {
		id: 1,
		size: 8,
		pageCount: 1,
		suffix: () => "pages 1",
		password: undefined,
		open: () => new Promise(() => undefined)
	} satisfies PdfDraft
	const access = "full" as unknown as PreviewAccessMode

	function mount(controller: PdfPagesController) {
		return render(
			<PdfDraftDocument
				draft={draft}
				item={item(false)}
				access={access}
				controller={controller}
			/>
		)
	}

	it("opens no discard question on Escape while its save runs", () => {
		harness.saving = true

		const closeDraft = vi.fn()

		mount({ closeDraft } as unknown as PdfPagesController)
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(closeDraft).not.toHaveBeenCalled()
	})

	it("does not discard on a question asked before its save started", async () => {
		const closeDraft = vi.fn()
		const controller = { closeDraft } as unknown as PdfPagesController
		const view = mount(controller)

		fireEvent.click(screen.getByRole("button", { name: "Close" }))

		const discard = await screen.findByRole("button", { name: "Discard" })

		harness.saving = true
		view.rerender(
			<PdfDraftDocument
				draft={draft}
				item={item(false)}
				access={access}
				controller={controller}
			/>
		)
		await act(async () => {
			fireEvent.click(discard)
			await Promise.resolve()
		})

		expect(closeDraft).not.toHaveBeenCalled()
	})
})
