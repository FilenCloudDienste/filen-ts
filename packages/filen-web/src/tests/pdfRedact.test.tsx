// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { RedactionFailure, RedactionFinding, RedactionMark } from "@filen/office/core/pdfedit/redactVerify"
import { previewPdfRedaction } from "@/locales/en/previewPdf/redaction"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

const logError = vi.fn()

vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { FindRedactPanel } = await import("@/features/pdf/redact/findRedactPanel")
const { RedactionMarksList } = await import("@/features/pdf/redact/redactionMarksList")
const { ApplyRedactionsDialog } = await import("@/features/pdf/redact/applyRedactionsDialog")
const { findForRedaction } = await import("@/features/pdf/redact/redactFlow")
const { addTerm, failureReason, findQuery, markLabel, redactedCopyName } = await import("@/features/pdf/redact/redaction.logic")

const suffix = (number: number): string => (number <= 1 ? "redacted" : `redacted ${String(number)}`)

const finding = (id: string, page: number, text: string): RedactionFinding => ({
	id,
	page,
	text,
	quads: [[0, 0, 1, 0, 0, 1, 1, 1]],
	source: { kind: "term", index: 0 }
})

const mark = (id: number, kind: RedactionMark["kind"], page = 0): RedactionMark => ({ id, page, kind, rect: [0, 0, 10, 10], quads: [] })

describe("redaction rules", () => {
	it("names the redacted copy beside the original", () => {
		expect(redactedCopyName("report.pdf", suffix, new Set())).toBe("report (redacted).pdf")
		expect(redactedCopyName("report.PDF", suffix, new Set(["report (redacted).pdf"]))).toBe("report (redacted 2).pdf")
		expect(redactedCopyName("notes", suffix, new Set())).toBe("notes (redacted).pdf")
	})

	it("words every failure with a reason string that exists", () => {
		const failures: RedactionFailure[] = [
			{ code: "revisions", count: 2 },
			{ code: "text", page: 3 },
			{ code: "image", page: 1 },
			{ code: "drawing", page: 2 },
			{ code: "term", term: "Ada", place: "page", page: 4 },
			{ code: "term", term: "Ada", place: "page" },
			...(["annotation", "field", "bookmark", "metadata", "attachment", "tags", "file"] as const).map(place => ({
				code: "term" as const,
				term: "Ada",
				place
			})),
			...(["info", "xmp", "attachments", "scripts", "pieceInfo"] as const).map(what => ({ code: "metadata" as const, what })),
			{ code: "hiddenData" },
			{ code: "unreadable", page: 9 }
		]

		for (const failure of failures) expect(previewPdfRedaction[failureReason(failure).key]).toBeTypeOf("string")

		expect(failureReason({ code: "text", page: 3 })).toEqual({
			key: "previewPdfRedactReasonText",
			params: { page: 3, term: "", text: "" }
		})
		expect(failureReason({ code: "term", term: "Ada", place: "page" }).key).toBe("previewPdfRedactReasonTermFile")
	})

	it("keeps the exact apply and failure strings", () => {
		expect(previewPdfRedaction.previewPdfRedactApplyWarning).toBe(
			"Applying redactions permanently deletes the marked text, image areas and drawings. Drawings that touch an area mark are deleted completely, including parts outside the mark. Text that is part of an image or a drawing is only removed where it is marked."
		)
		expect(previewPdfRedaction.previewPdfRedactVerifyFailed).toBe(
			"The redacted file didn't pass the check, so it wasn't saved: {{reason}}."
		)
	})

	it("adds trimmed, distinct terms and builds the query", () => {
		expect(addTerm(["a"], "  b ")).toEqual(["a", "b"])
		expect(addTerm(["a"], "a")).toEqual(["a"])
		expect(addTerm(["a"], "   ")).toEqual(["a"])
		expect(findQuery({ terms: ["x"], matchCase: true, wholeWord: false, presets: ["emails"] })).toEqual({
			terms: [{ text: "x", matchCase: true, wholeWord: false }],
			presets: ["emails"]
		})
	})

	it("labels marks by kind", () => {
		expect(markLabel(mark(1, "area"), undefined).key).toBe("previewPdfRedactMarkArea")
		expect(markLabel(mark(1, "page"), undefined).key).toBe("previewPdfRedactMarkPage")
		expect(markLabel(mark(1, "text"), "x".repeat(80)).params.text).toHaveLength(60)
		expect(markLabel(mark(1, "text"), undefined).key).toBe("previewPdfRedactMarkTextUnknown")
	})
})

describe("redaction controls", () => {
	it("searches the typed terms with the options and marks the selected results", () => {
		const onSearch = vi.fn()
		const onMark = vi.fn()
		const props = { searching: false, failed: false, onSearch, onMark, onClose: vi.fn() }
		const { rerender } = render(
			<FindRedactPanel
				findings={null}
				{...props}
			/>
		)

		fireEvent.change(screen.getByLabelText("previewPdfFindRedactTermLabel"), { target: { value: "Ada Lovelace" } })
		fireEvent.click(screen.getByLabelText("previewPdfFindRedactMatchCase"))
		fireEvent.click(screen.getByLabelText("previewPdfFindRedactPhones"))
		fireEvent.click(screen.getByRole("button", { name: "previewPdfFindRedactSearch" }))

		expect(onSearch).toHaveBeenCalledWith(
			{ terms: [{ text: "Ada Lovelace", matchCase: true, wholeWord: false }], presets: ["phoneNumbers"] },
			expect.objectContaining({ terms: ["Ada Lovelace"] })
		)

		const findings = [finding("0:0", 0, "Ada Lovelace"), finding("2:0", 2, "+1 555 010 7788")]

		rerender(
			<FindRedactPanel
				findings={findings}
				{...props}
			/>
		)

		expect(screen.getByText('previewPdfFindRedactResults {"count":2}')).toBeTruthy()
		fireEvent.click(screen.getByLabelText(/\+1 555 010 7788/))
		fireEvent.click(screen.getByRole("button", { name: 'previewPdfFindRedactMark {"count":1}' }))
		expect(onMark).toHaveBeenCalledWith([findings[0]])

		// A new search selects every result again.
		rerender(
			<FindRedactPanel
				findings={[...findings]}
				{...props}
			/>
		)
		expect(screen.getByRole("button", { name: 'previewPdfFindRedactMark {"count":2}' })).toBeTruthy()
	})

	it("says a failed search failed, never that nothing matched", () => {
		const props = { searching: false, onSearch: vi.fn(), onMark: vi.fn(), onClose: vi.fn() }
		const { rerender } = render(
			<FindRedactPanel
				findings={null}
				failed={false}
				{...props}
			/>
		)

		// The status is there (empty) before any search, so its outcome is announced.
		expect(screen.getByRole("status").textContent).toBe("")

		rerender(
			<FindRedactPanel
				findings={null}
				failed
				{...props}
			/>
		)

		expect(screen.getByRole("status").textContent).toBe("previewPdfFindRedactFailed")
		expect(screen.queryByText("previewPdfFindRedactNoResults")).toBeNull()
	})

	it("reports an engine failure of a search as no findings, logged and not remembered", async () => {
		const failure = new Error("engine trap")
		const call = vi.fn((op: string): Promise<RedactionFinding[]> =>
			op === "redactFind" ? Promise.reject(failure) : Promise.resolve([])
		)
		const session = { engine: { call } } as unknown as Parameters<typeof findForRedaction>[0]
		const query = { terms: [{ text: "Ada", matchCase: false, wholeWord: false }], presets: [] }

		await expect(findForRedaction(session, query)).resolves.toBeNull()
		expect(logError).toHaveBeenCalledWith("pdf", expect.any(String), { error: failure })

		call.mockImplementation(() => Promise.resolve([finding("0:0", 0, "Ada")]))
		await expect(findForRedaction(session, query)).resolves.toHaveLength(1)
	})

	it("lists the marks, removes one and opens the apply dialog", () => {
		const onRemove = vi.fn()
		const onApply = vi.fn()
		const marks = [mark(7, "text", 0), mark(9, "area", 2)]

		render(
			<RedactionMarksList
				marks={marks}
				texts={new Map([[7, "Ada"]])}
				onRemove={onRemove}
				onApply={onApply}
			/>
		)

		expect(screen.getByText('previewPdfRedactMarked {"count":2}')).toBeTruthy()
		expect(screen.getByText('previewPdfRedactMarkText {"page":0,"term":"","text":"Ada"}')).toBeTruthy()
		expect(screen.getByText('previewPdfPageNumber {"page":3}')).toBeTruthy()
		// Each ✕ is named after its own mark.
		fireEvent.click(
			screen.getByRole("button", {
				name: `previewPdfRedactRemoveMark ${JSON.stringify({ index: 2, mark: 'previewPdfRedactMarkArea {"page":0,"term":"","text":""}', page: 3 })}`
			})
		)
		expect(onRemove).toHaveBeenCalledWith(marks[1])
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApply" }))
		expect(onApply).toHaveBeenCalled()
	})

	it("moves focus to the mark in a removed one's place, then the one before, then the heading", () => {
		const marks = [mark(1, "area", 0), mark(2, "area", 0), mark(3, "page", 1)]
		const props = { onRemove: vi.fn(), onApply: vi.fn() }
		const { rerender } = render(
			<RedactionMarksList
				marks={marks}
				{...props}
			/>
		)
		const remove = (index: number): HTMLElement => {
			const button = screen.getAllByRole("button", { name: /^previewPdfRedactRemoveMark/ })[index]

			if (button === undefined) throw new Error("missing remove button")

			return button
		}

		remove(1).focus()
		fireEvent.click(remove(1))
		rerender(
			<RedactionMarksList
				marks={[marks[0], marks[2]].filter(entry => entry !== undefined)}
				{...props}
			/>
		)
		expect(document.activeElement).toBe(remove(1))

		fireEvent.click(remove(1))
		rerender(
			<RedactionMarksList
				marks={marks.slice(0, 1)}
				{...props}
			/>
		)
		expect(document.activeElement).toBe(remove(0))

		fireEvent.click(remove(0))
		rerender(
			<RedactionMarksList
				marks={[]}
				{...props}
			/>
		)
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: 'previewPdfRedactMarked {"count":0}' }))
	})

	it("disables Apply while nothing is marked", () => {
		render(
			<RedactionMarksList
				marks={[]}
				onRemove={vi.fn()}
				onApply={vi.fn()}
			/>
		)

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "previewPdfRedactApply" }).disabled).toBe(true)
	})

	it("applies with Sanitize on and a redacted copy by default, and says why a check failed", () => {
		const onApply = vi.fn()
		const props = {
			open: true,
			onOpenChange: vi.fn(),
			fileName: "contract.pdf",
			// The mocked t returns keys, so the first suffix reads as its key.
			takenNames: new Set(["contract (previewpdfredactcopysuffix).pdf"]),
			canSaveInPlace: true,
			tagged: false,
			busy: false,
			onApply
		}
		const { rerender } = render(
			<ApplyRedactionsDialog
				{...props}
				failure={null}
			/>
		)

		expect(screen.getByText("previewPdfRedactApplyWarning")).toBeTruthy()
		expect(screen.queryByText("previewPdfTagged")).toBeNull()
		expect(screen.getByLabelText<HTMLInputElement>("previewPdfRedactSanitize").checked).toBe(true)
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApplyConfirm" }))
		expect(onApply).toHaveBeenLastCalledWith({
			sanitize: true,
			removeAnnotations: true,
			destination: { kind: "copy", name: 'contract (previewPdfRedactCopySuffixNumbered {"number":2}).pdf' }
		})

		fireEvent.click(screen.getByLabelText("previewPdfRedactSanitize"))
		fireEvent.click(screen.getByRole("radio", { name: "previewPdfRedactSaveInPlace" }))
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApplyConfirm" }))
		expect(onApply).toHaveBeenLastCalledWith({ sanitize: false, removeAnnotations: true, destination: { kind: "inPlace" } })

		rerender(
			<ApplyRedactionsDialog
				{...props}
				failure={{ code: "text", page: 2 }}
			/>
		)

		expect(screen.getByRole("alert").textContent).toContain("previewPdfRedactVerifyFailed")
		expect(screen.getByRole("alert").textContent).toContain("previewPdfRedactReasonText")

		// A document with accessibility tags is told a redaction may leave them incomplete.
		rerender(
			<ApplyRedactionsDialog
				{...props}
				tagged
				failure={null}
			/>
		)

		expect(screen.getByText("previewPdfTagged")).toBeTruthy()
	})
})
