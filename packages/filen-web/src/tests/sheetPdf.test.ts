import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SheetSessionApi } from "@filen/office/core/sheet"
import type { SheetPdfRequest } from "@filen/office/react/sheet/print"

// Download as PDF for a spreadsheet: the job runs where the session runs, the page gets the file as one Blob and
// downloads it as "<name>.pdf"; refusals and failures tell the user, the user's own Cancel says nothing.

const toast = vi.hoisted(() => ({ loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), warning: vi.fn() }))
const downloads = vi.hoisted(() => [] as { name: string; blob: Blob }[])

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/i18n", () => ({
	i18n: { t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key} ${JSON.stringify(values)}`) }
}))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/downloadBlob", () => ({
	downloadBlob: (name: string, blob: Blob) => {
		downloads.push({ name, blob })
	}
}))

const { downloadSheetPdf, pdfDownloadName } = await import("@/features/spreadsheet/save/sheetPdf")
const { formOf, headerValues, pdfRequest, printRequests } = await import("@/features/spreadsheet/print/print.logic")
const { DEFAULT_PAGE_SETUP } = await import("@filen/office/core/sheet/print")

const REQUEST: SheetPdfRequest = pdfRequest(
	[],
	{ name: "Budget.xlsx", title: "Budget", lang: "de-DE" },
	{ kind: "xlsx", sheets: [], date1904: false, showFormulas: false },
	"de-DE",
	new Date(2026, 0, 2, 10, 0)
)

function session(
	job: (name: string, args: unknown, options: { signal?: AbortSignal; onProgress?: (value: unknown) => void }) => Promise<unknown>
): SheetSessionApi {
	return { job } as unknown as SheetSessionApi
}

beforeEach(() => {
	downloads.length = 0
	vi.clearAllMocks()
})

describe("a spreadsheet's PDF download", () => {
	it("names the PDF after the file and builds the request with the file's title, language and header values", () => {
		expect(pdfDownloadName("Budget 2026.xlsx")).toBe("Budget 2026.pdf")
		expect(REQUEST).toMatchObject({ title: "Budget", lang: "de-DE", kind: "xlsx", values: { file: "Budget.xlsx", path: "" } })
		expect(REQUEST.values.date).not.toBe("")
	})

	it("prints the header's date and time in the regional language it is given", () => {
		expect(REQUEST.values).toMatchObject({ date: "02.01.26", time: "10:00" })
		expect(headerValues("a.xlsx", "en-US", new Date(2026, 2, 14, 10, 0))).toMatchObject({ date: "3/14/26", file: "a.xlsx" })
		expect(headerValues("a.xlsx", "de-DE", new Date(2026, 2, 14, 10, 0)).date).toBe("14.03.26")
	})

	it("runs the PDF job, counts its pages in the toast and downloads the Blob it answers", async () => {
		const blob = new Blob(["%PDF"], { type: "application/pdf" })
		const job = vi.fn((_name: string, _args: unknown, options: { signal?: AbortSignal; onProgress?: (value: unknown) => void }) => {
			options.onProgress?.({ done: 3, total: 9 })

			return Promise.resolve({ ok: true, blob, pages: 9, missingImages: 0, missingGlyphs: 0, unshapedRuns: 0, missingObjects: 0 })
		})

		await downloadSheetPdf(session(job), REQUEST, "Budget.xlsx")

		expect(job.mock.calls[0]?.slice(0, 2)).toEqual(["print.pdf", { request: REQUEST }])
		expect(job.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal)
		expect(toast.loading).toHaveBeenLastCalledWith('preview:previewSheetPdfProgress {"done":3,"total":9}', expect.anything())
		expect(downloads).toEqual([{ name: "Budget.pdf", blob }])
		expect(toast.error).not.toHaveBeenCalled()
		expect(toast.warning).not.toHaveBeenCalled()
	})

	it("says when characters or pictures could not be put in", async () => {
		await downloadSheetPdf(
			session(() =>
				Promise.resolve({
					ok: true,
					blob: new Blob([]),
					pages: 1,
					missingImages: 1,
					missingGlyphs: 0,
					unshapedRuns: 0,
					missingObjects: 0
				})
			),
			REQUEST,
			"a.xlsx"
		)

		expect(toast.warning.mock.calls).toEqual([["preview:previewSheetPdfSimplified"]])
	})

	it("says when some text is drawn without its font's shaping", async () => {
		await downloadSheetPdf(
			session(() =>
				Promise.resolve({
					ok: true,
					blob: new Blob([]),
					pages: 1,
					missingImages: 0,
					missingGlyphs: 0,
					unshapedRuns: 2,
					missingObjects: 0
				})
			),
			REQUEST,
			"a.xlsx"
		)

		expect(toast.warning.mock.calls).toEqual([["preview:previewSheetPdfUnshaped"]])
		expect(downloads).toHaveLength(1)
	})

	it("tells the user why nothing was made: nothing prints, too many pages, a page too large, a password a PDF cannot take, a session that cannot make one", async () => {
		await downloadSheetPdf(
			session(() => Promise.resolve({ ok: false, reason: "nothing" })),
			REQUEST,
			"a.xlsx"
		)
		await downloadSheetPdf(
			session(() => Promise.resolve({ ok: false, reason: "tooManyPages", pages: 10_000 })),
			REQUEST,
			"a.xlsx"
		)
		await downloadSheetPdf(
			session(() => Promise.resolve({ ok: false, reason: "pageTooLarge", pages: 3 })),
			REQUEST,
			"a.xlsx"
		)
		await downloadSheetPdf(
			session(() => Promise.resolve({ ok: false, reason: "passwordUnsupported" })),
			REQUEST,
			"a.xlsx"
		)
		await downloadSheetPdf({} as SheetSessionApi, REQUEST, "a.xlsx")

		expect(toast.error.mock.calls.map(call => String(call[0]))).toEqual([
			"preview:previewSheetPdfNothing",
			'preview:previewSheetPdfTooMany {"pages":10000}',
			'preview:previewSheetPdfPageTooLarge {"page":3}',
			"preview:previewSheetPdfPasswordUnsupported",
			"preview:previewSheetPdfFailed"
		])
		expect(downloads).toEqual([])
	})

	it("says nothing after the user's own Cancel, and reports a failure otherwise", async () => {
		const cancelled = downloadSheetPdf(
			session(
				(_name, _args, options) =>
					new Promise((_resolve, reject) => {
						options.signal?.addEventListener("abort", () => {
							reject(new Error("The PDF export was aborted"))
						})
					})
			),
			REQUEST,
			"a.xlsx"
		)
		const action = (toast.loading.mock.calls[0]?.[1] as { action: { onClick: () => void } }).action

		action.onClick()
		await cancelled
		expect(toast.error).not.toHaveBeenCalled()

		await downloadSheetPdf(
			session(() => Promise.reject(new Error("worker died"))),
			REQUEST,
			"a.xlsx"
		)
		expect(toast.error).toHaveBeenCalledWith("preview:previewSheetPdfFailed")
	})

	it("says nothing when the viewer is closed while its PDF is being made", async () => {
		await downloadSheetPdf(
			session(() => Promise.resolve({ ok: false, reason: "closed" })),
			REQUEST,
			"a.xlsx"
		)

		expect(toast.error).not.toHaveBeenCalled()
		expect(toast.dismiss).toHaveBeenCalledTimes(1)
		expect(downloads).toEqual([])
	})

	it("sends the password with that one export, to encrypt the PDF", async () => {
		const job = vi.fn((_name: string, _args: unknown) =>
			Promise.resolve({
				ok: true,
				blob: new Blob([]),
				pages: 1,
				missingImages: 0,
				missingGlyphs: 0,
				unshapedRuns: 0,
				missingObjects: 0
			})
		)

		await downloadSheetPdf(session(job), REQUEST, "a.xlsx", "secret")

		expect(job.mock.calls[0]?.[1]).toEqual({ request: REQUEST, password: "secret" })
	})

	it("prints a chartsheet as its chart, whatever the scope", () => {
		const chart = { part: "xl/charts/chart9.xml", width: 5_486_400, height: 3_657_600 }
		const active = {
			sheet: { id: 3, name: "Graph", state: "visible", kind: "chartsheet" } as never,
			setup: DEFAULT_PAGE_SETUP,
			used: null,
			chart
		}

		for (const scope of ["sheet", "workbook", "selection"] as const)
			expect(printRequests(formOf(DEFAULT_PAGE_SETUP, scope), active, [active], [])?.[0]?.chart).toEqual(chart)
	})
})
