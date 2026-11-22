// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { RedactionFailure, RedactionFinding, RedactionMark, RedactionQuery } from "@filen/office/core/pdfedit/redactVerify"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { PdfToolContext, PdfToolSaveOutcome } from "@/features/pdf/tools/registry"
import { previewPdfRedaction } from "@/locales/en/previewPdf/redaction"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

const logError = vi.fn()

vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const toastError = vi.fn()

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }))

const { FindRedactPanel } = await import("@/features/pdf/redact/findRedactPanel")
const { RedactionMarksList } = await import("@/features/pdf/redact/redactionMarksList")
const { ApplyRedactionsDialog } = await import("@/features/pdf/redact/applyRedactionsDialog")
const { applyRedactions, findForRedaction, rememberSearch } = await import("@/features/pdf/redact/redactFlow")
const { RedactAreaPanel } = await import("@/features/pdf/redact/redactPanel")
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

// jsdom lays nothing out, and the results' virtualizer renders no rows into a viewport of no size: every element
// reports a 440px client height (ten rows) until restored.
function sizedViewport(): { restore: () => void } {
	const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(440)

	return {
		restore: () => {
			height.mockRestore()
		}
	}
}

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
		expect(markLabel(mark(1, "area")).key).toBe("previewPdfRedactMarkArea")
		expect(markLabel(mark(1, "page")).key).toBe("previewPdfRedactMarkPage")
		expect(markLabel({ ...mark(1, "text"), text: "x".repeat(80) }).params.text).toHaveLength(60)
		expect(markLabel({ ...mark(1, "text"), text: "" }).key).toBe("previewPdfRedactMarkTextUnknown")
		expect(markLabel(mark(1, "text")).key).toBe("previewPdfRedactMarkTextUnknown")
	})
})

describe("redaction controls", () => {
	it("searches the typed terms with the options and marks the selected results", () => {
		const viewport = sizedViewport()
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
		viewport.restore()
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
		const viewport = sizedViewport()

		const onRemove = vi.fn()
		const onApply = vi.fn()
		const marks = [{ ...mark(7, "text", 0), text: "Ada" }, mark(9, "area", 2)]

		render(
			<RedactionMarksList
				marks={marks}
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
		viewport.restore()
	})

	it("moves focus to the mark in a removed one's place, then the one before, then the heading", () => {
		const viewport = sizedViewport()

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
		viewport.restore()
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

// An editor session keeping its history as labels (dispatch adds one, undo and redo move it), its marks, the
// searches its engine ran and how many reads of the marks asked for their text (the panel's).
function historySession(options: { history?: string[]; marks?: RedactionMark[]; failing?: boolean } = {}) {
	const history = [...(options.history ?? [])]
	const redo: string[] = []
	const finds: RedactionQuery[] = []
	const textReads = { count: 0 }
	const listeners = new Set<() => void>()
	let snapshot = { state: { revision: 1, undoLabel: history.at(-1) ?? null, tagged: false } }
	const changed = (): void => {
		snapshot = { state: { revision: snapshot.state.revision + 1, undoLabel: history.at(-1) ?? null, tagged: false } }

		for (const listener of listeners) listener()
	}
	const session = {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		dispatch: (command: string) => {
			history.push(command)
			redo.length = 0
			changed()

			return Promise.resolve({})
		},
		undo: (count = 1) => {
			for (let step = 0; step < count; step++) {
				const label = history.pop()

				if (label !== undefined) redo.push(label)
			}

			changed()

			return Promise.resolve({})
		},
		redo: () => {
			const label = redo.pop()

			if (label !== undefined) history.push(label)

			changed()

			return Promise.resolve({})
		},
		engine: {
			call: (op: string, args: { query?: RedactionQuery; text?: boolean }) => {
				if (options.failing === true) return Promise.reject(new Error("engine trap"))

				if (op === "redactMarks") {
					if (args.text === true) textReads.count++

					return Promise.resolve(options.marks ?? [mark(1, "area", 0)])
				}

				if (op === "redactFind" && args.query !== undefined) finds.push(args.query)

				return Promise.resolve([])
			}
		}
	} as unknown as PdfEditSessionModel

	return { session, history, finds, textReads }
}

function toolContext(session: PdfEditSessionModel, save: (session: PdfEditSessionModel) => Promise<PdfToolSaveOutcome>): PdfToolContext {
	return {
		edit: (change: (current: PdfEditSessionModel) => Promise<unknown>) => {
			void change(session)
		},
		finish: vi.fn(),
		host: {
			fileName: "contract.pdf",
			takenNames: () => Promise.resolve(new Set<string>()),
			canSaveInPlace: true,
			save: () => save(session),
			close: vi.fn()
		}
	} as unknown as PdfToolContext
}

const inPlace = { sanitize: true, removeAnnotations: true, destination: { kind: "inPlace" }, copySuffix: suffix } as const

describe("applying redactions", () => {
	it("undoes the version save's flatten step with the redaction steps when the save fails", async () => {
		const { session, history } = historySession({ history: ["annotations.add"] })
		const context = toolContext(session, async current => {
			// Flatten annotations: the save's own step on top, then the save fails.
			await current.dispatch("annotations.flatten", {})

			return { status: "failed", error: new Error("upload failed") }
		})

		expect(await applyRedactions(context, inPlace)).toMatchObject({ kind: "failed" })
		expect(history).toEqual(["annotations.add"])
	})

	it("keeps a flatten step an earlier save left below the redaction steps", async () => {
		const { session, history } = historySession({ history: ["annotations.flatten"] })
		const context = toolContext(session, () => Promise.resolve({ status: "failed", error: new Error("upload failed") }))

		expect(await applyRedactions(context, inPlace)).toMatchObject({ kind: "failed" })
		expect(history).toEqual(["annotations.flatten"])
	})

	it("puts back a flatten step on top with no redaction step under it", async () => {
		// Applying fails before any step: the flatten on top is not the save's.
		const { session, history } = historySession({ history: ["annotations.flatten"], failing: true })
		const context = toolContext(session, () => Promise.resolve({ status: "saved", name: null }))

		expect(await applyRedactions(context, inPlace)).toMatchObject({ kind: "failed" })
		expect(history).toEqual(["annotations.flatten"])
	})

	it("tells a save that did not start from nothing to apply", async () => {
		const empty = historySession({ marks: [] })

		expect(
			await applyRedactions(
				toolContext(empty.session, () => Promise.resolve({ status: "saved", name: null })),
				inPlace
			)
		).toEqual({
			kind: "cancelled",
			reason: "nothing"
		})

		const { session, history } = historySession()

		expect(
			await applyRedactions(
				toolContext(session, () => Promise.resolve({ status: "cancelled" })),
				inPlace
			)
		).toEqual({
			kind: "cancelled",
			reason: "save"
		})
		expect(history).toEqual([])
	})

	it("searches each distinct remembered query once before applying", async () => {
		const { session, finds } = historySession()
		const query = (matchCase: boolean): RedactionQuery => ({ terms: [{ text: "Ada", matchCase, wholeWord: false }], presets: [] })

		for (let search = 0; search < 5; search++) rememberSearch(session, query(false))

		await applyRedactions(
			toolContext(session, () => Promise.resolve({ status: "saved", name: null })),
			inPlace
		)
		expect(finds).toEqual([query(false)])

		rememberSearch(session, query(true))
		finds.length = 0
		await applyRedactions(
			toolContext(session, () => Promise.resolve({ status: "saved", name: null })),
			inPlace
		)
		expect(finds).toEqual([query(false), query(true)])
	})

	it("says once that the save failed when it could not start, and nothing when there was nothing to apply", async () => {
		toastError.mockClear()

		const { session } = historySession()
		const view = render(
			<RedactAreaPanel
				context={toolContext(session, () => Promise.resolve({ status: "cancelled" }))}
				document={{} as PdfDomDocument}
				active
				phone={false}
			/>
		)

		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", { name: "previewPdfRedactApply" }).disabled).toBe(false)
		})
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApply" }))
		fireEvent.click(screen.getByRole("radio", { name: "previewPdfRedactSaveInPlace" }))
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApplyConfirm" }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledTimes(1)
		})
		expect(toastError).toHaveBeenCalledWith("previewPdfSaveFailed")
		view.unmount()
	})
})

describe("the marks list in the panel", () => {
	it("reads the marks with their text once when an apply ends, not for each page it applies", async () => {
		toastError.mockClear()

		const { session, history, textReads } = historySession({
			marks: [mark(1, "text", 0), mark(2, "text", 1), mark(3, "text", 2), mark(4, "text", 3)]
		})
		const view = render(
			<RedactAreaPanel
				context={toolContext(session, () => Promise.resolve({ status: "failed", error: new Error("upload failed") }))}
				document={{} as PdfDomDocument}
				active
				phone={false}
			/>
		)

		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", { name: "previewPdfRedactApply" }).disabled).toBe(false)
		})
		expect(textReads.count).toBe(1)
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApply" }))
		fireEvent.click(screen.getByRole("radio", { name: "previewPdfRedactSaveInPlace" }))
		fireEvent.click(screen.getByRole("button", { name: "previewPdfRedactApplyConfirm" }))
		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("previewPdfRedactSaveFailed")
		})
		// Four pages applied and undone again: eight changes while the apply ran, one read after it.
		expect(history).toEqual([])
		await waitFor(() => {
			expect(textReads.count).toBe(2)
		})
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(textReads.count).toBe(2)
		view.unmount()
	})

	it("shows a mark's page when its row is chosen", async () => {
		const viewport = sizedViewport()

		const { session } = historySession({ marks: [mark(4, "area", 0), mark(5, "area", 2)] })
		const show = vi.fn()
		const context = {
			...toolContext(session, () => Promise.resolve({ status: "cancelled" })),
			pages: { show }
		} as unknown as PdfToolContext
		const view = render(
			<RedactAreaPanel
				context={context}
				document={{} as PdfDomDocument}
				active
				phone={false}
			/>
		)
		const row = await screen.findByText('previewPdfPageNumber {"page":3}')

		fireEvent.click(row)
		expect(show).toHaveBeenCalledWith(2)
		view.unmount()
		viewport.restore()
	})
})

describe("the marks list with many marks", () => {
	it("mounts a window of the marks, and moves focus to the mark in a removed far one's place", () => {
		const viewport = sizedViewport()
		const marks = Array.from({ length: 5_000 }, (_, index) => mark(index + 1, "area", index))
		const props = { onRemove: vi.fn(), onApply: vi.fn() }
		const { rerender } = render(
			<RedactionMarksList
				marks={marks}
				{...props}
			/>
		)

		expect(screen.getAllByRole("listitem").length).toBeLessThan(40)

		const scroller = screen.getAllByRole("listitem")[0]?.closest("ul")?.parentElement

		if (scroller === null || scroller === undefined) throw new Error("no scroller")

		act(() => {
			scroller.scrollTop = 5_000 * 44
			scroller.dispatchEvent(new Event("scroll"))
		})

		const last = screen.getAllByRole("listitem").find(row => row.getAttribute("aria-posinset") === "5000")
		const remove = last?.querySelector<HTMLElement>("[data-mark-remove]")

		if (remove === null || remove === undefined) throw new Error("last mark not mounted")

		remove.focus()
		fireEvent.click(remove)
		expect(props.onRemove).toHaveBeenCalledWith(marks[4_999])
		rerender(
			<RedactionMarksList
				marks={marks.slice(0, -1)}
				{...props}
			/>
		)
		expect(document.activeElement?.closest("li")?.getAttribute("aria-posinset")).toBe("4999")
		viewport.restore()
	})
})

describe("find & redact with many results", () => {
	it("mounts a window of rows, counts and marks every selected finding", () => {
		const viewport = sizedViewport()
		const onMark = vi.fn()
		const findings = Array.from({ length: 20_000 }, (_, index) => finding(`${String(index)}:0`, index, `match ${String(index)}`))

		render(
			<FindRedactPanel
				findings={findings}
				searching={false}
				failed={false}
				onSearch={vi.fn()}
				onMark={onMark}
				onClose={vi.fn()}
			/>
		)

		const rows = screen.getAllByRole("listitem")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(100)
		expect(screen.getByRole("status").textContent).toBe('previewPdfFindRedactResults {"count":20000}')

		fireEvent.click(screen.getByLabelText(/^match 3previewPdfPageNumber/))
		fireEvent.click(screen.getByRole("button", { name: 'previewPdfFindRedactMark {"count":19999}' }))

		const marked = onMark.mock.calls[0]?.[0] as RedactionFinding[]

		expect(marked).toHaveLength(19_999)
		expect(marked.some(item => item.id === "3:0")).toBe(false)
		expect(marked.at(-1)?.id).toBe("19999:0")
		viewport.restore()
	})
})
