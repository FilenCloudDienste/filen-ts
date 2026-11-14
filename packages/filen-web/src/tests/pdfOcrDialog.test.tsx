// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
		i18n: { language: "en" }
	})
}))

const stored = vi.hoisted((): { value: unknown } => ({ value: null }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(stored.value),
	kvSetJson: (_key: string, value: unknown) => {
		stored.value = value

		return Promise.resolve()
	}
}))

const { RecogniseTextDialog } = await import("@/features/pdf/ocr/recogniseTextDialog")
const { OcrLanguagesRow } = await import("@/features/pdf/ocr/ocrLanguagesRow")
const {
	loadOcrLanguages,
	setOcrLanguages,
	pickedOcrLanguages,
	ocrLanguagesToDownload,
	markOcrLanguagesDownloaded,
	useOcrLanguagePreference
} = await import("@/features/pdf/ocr/ocrLanguagePreference")
const { ocrChosenPages, updatePageState, waitingPages, settledCount } = await import("@/features/pdf/ocr/recogniseText.logic")
const { ocrWorkerCount } = await import("@/features/pdf/ocr/ocrSession")
const { ocrEngineVariant } = await import("@/features/pdf/ocr/ocrWorkerHost")

type DialogProps = Parameters<typeof RecogniseTextDialog>[0]

function dialog(overrides: Partial<DialogProps> = {}) {
	const props: DialogProps = {
		pageCount: 10,
		scanned: [0, 2, 3, 7],
		languages: ["deu", "eng"],
		downloadBytes: 2_812_246,
		run: null,
		onLanguagesChange: vi.fn(),
		onStart: vi.fn(),
		onCancel: vi.fn(),
		onClose: vi.fn(),
		...overrides
	}

	render(<RecogniseTextDialog {...props} />)

	return props
}

describe("Recognise text logic", () => {
	it("recognises only the scanned pages among those chosen", () => {
		expect(ocrChosenPages({ pages: "all", range: "" }, 10, [7, 0, 3])).toEqual([0, 3, 7])
		expect(ocrChosenPages({ pages: "range", range: "1-3, 8" }, 10, [0, 2, 3, 7])).toEqual([0, 2, 7])
		expect(ocrChosenPages({ pages: "range", range: "12" }, 10, [0])).toBeNull()
	})

	it("tracks each page through a run", () => {
		let pages = waitingPages([0, 2])

		pages = updatePageState(pages, 2, null)
		expect(pages.map(state => state.status)).toEqual(["waiting", "working"])
		pages = updatePageState(pages, 2, { page: 2, status: "done", words: 12, confidence: 90 })
		pages = updatePageState(pages, 0, { page: 0, status: "failed", reason: "x" })
		expect(pages).toEqual([
			{ page: 0, status: "failed", words: 0 },
			{ page: 2, status: "done", words: 12 }
		])
		expect(settledCount(pages)).toBe(2)
	})

	it("uses two workers only on a large Chromium machine", () => {
		expect(ocrWorkerCount({ chromium: true, deviceMemory: 8, hardwareConcurrency: 8 })).toBe(2)
		expect(ocrWorkerCount({ chromium: true, deviceMemory: 4, hardwareConcurrency: 16 })).toBe(1)
		expect(ocrWorkerCount({ chromium: false, deviceMemory: undefined, hardwareConcurrency: 16 })).toBe(1)
	})

	it("picks the best engine build the browser validates", () => {
		expect(ocrEngineVariant(() => true)).toBe("relaxedsimd-lstm")
		expect(ocrEngineVariant(bytes => bytes.length < 33)).toBe("simd-lstm")
		expect(ocrEngineVariant(() => false)).toBe("lstm")
	})
})

describe("OCR language preference", () => {
	it("defaults to the UI language and English, and keeps picks and downloads", async () => {
		expect(pickedOcrLanguages({ languages: null, downloaded: [] }, "de")).toEqual(["deu", "eng"])
		expect(pickedOcrLanguages({ languages: ["jpn", "gone"], downloaded: [] }, "de")).toEqual(["jpn"])
		expect(pickedOcrLanguages({ languages: [], downloaded: [] }, "pt-BR")).toEqual(["por", "eng"])
		expect(ocrLanguagesToDownload({ languages: null, downloaded: ["eng"] }, ["deu", "eng"])).toEqual(["deu"])

		stored.value = { languages: ["fra"], downloaded: [] }
		await loadOcrLanguages()
		markOcrLanguagesDownloaded(["fra"])
		expect(stored.value).toEqual({ languages: ["fra"], downloaded: ["fra"] })
		expect(typeof useOcrLanguagePreference).toBe("function")
	})
})

describe("RecogniseTextDialog", () => {
	it("says how many scanned pages it will recognise and starts with them", () => {
		const props = dialog()

		expect(screen.getByText('previewPdfOcrScanned {"count":4}')).toBeTruthy()
		expect(screen.getByText(/previewPdfOcrDownload/)).toBeTruthy()

		fireEvent.change(screen.getByLabelText("previewPdfOcrRangeLabel"), { target: { value: "3-8" } })
		expect(screen.getByText('previewPdfOcrScanned {"count":3}')).toBeTruthy()
		fireEvent.click(screen.getByText("previewPdfOcrStart"))
		expect(props.onStart).toHaveBeenCalledWith([2, 3, 7])
	})

	it("refuses an unreadable range and pages without scans", () => {
		dialog({ scanned: [] })

		expect(screen.getByText("previewPdfOcrNoScanned")).toBeTruthy()
		expect(screen.getByText("previewPdfOcrStart").closest("button")?.disabled).toBe(true)
	})

	it("removes a language but never the last one", () => {
		const props = dialog({ downloadBytes: 0 })

		expect(screen.queryByText(/previewPdfOcrDownload/)).toBeNull()

		const remove = screen.getByLabelText('previewPdfOcrRemoveLanguage {"language":"German"}')

		fireEvent.click(remove)
		expect(props.onLanguagesChange).toHaveBeenCalledWith(["eng"])
	})

	it("keeps the only language", () => {
		dialog({ languages: ["eng"] })

		expect(screen.getByLabelText<HTMLButtonElement>('previewPdfOcrRemoveLanguage {"language":"English"}').disabled).toBe(true)
	})

	it("shows the download, then each page, with Cancel", () => {
		const props = dialog({ run: { phase: "downloading", loaded: 50, total: 200 } })

		expect(screen.getAllByText('previewPdfOcrDownloading {"percent":25}').length).toBeGreaterThan(0)
		fireEvent.click(screen.getByText("common:cancel"))
		expect(props.onCancel).toHaveBeenCalled()
	})

	it("lists every page's progress while recognising", () => {
		dialog({
			run: {
				phase: "recognising",
				pages: [
					{ page: 0, status: "done", words: 3 },
					{ page: 2, status: "working", words: 0 },
					{ page: 3, status: "waiting", words: 0 }
				]
			}
		})

		expect(screen.getByText('previewPdfOcrPageWords {"count":3}')).toBeTruthy()
		expect(screen.getByText("previewPdfOcrPageWorking")).toBeTruthy()
		expect(screen.getByText('previewPdfOcrPage {"page":4}')).toBeTruthy()
	})

	it("sums up a finished run with its failures", () => {
		const props = dialog({
			run: {
				phase: "finished",
				cancelled: true,
				pages: [
					{ page: 0, status: "done", words: 3 },
					{ page: 2, status: "failed", words: 0 }
				]
			}
		})

		expect(screen.getByText("previewPdfOcrCancelled")).toBeTruthy()
		expect(screen.getByText('previewPdfOcrDone {"count":1}')).toBeTruthy()
		expect(screen.getByText('previewPdfOcrFailed {"count":1}')).toBeTruthy()
		expect(screen.getByText("previewPdfOcrPageFailed")).toBeTruthy()
		fireEvent.click(screen.getByText("common:close"))
		expect(props.onClose).toHaveBeenCalled()
	})

	it("says when the language data could not be downloaded", () => {
		dialog({ run: { phase: "modelsFailed" } })

		expect(screen.getByRole("alert").textContent).toBe("previewPdfOcrModelsFailed")
		expect(screen.getByText("previewPdfOcrStart")).toBeTruthy()
	})
})

describe("OcrLanguagesRow", () => {
	it("lists the languages and saves a change", () => {
		// Loaded once already (above): the held value is what the row shows.
		setOcrLanguages(["fra", "eng"])
		render(<OcrLanguagesRow />)

		expect(screen.getByText("French, English")).toBeTruthy()
		fireEvent.click(screen.getByText("previewPdfOcrSettingsChange"))
		fireEvent.click(screen.getByLabelText('previewPdfOcrRemoveLanguage {"language":"French"}'))
		fireEvent.click(screen.getByText("previewPdfOcrSettingsSave"))
		expect(stored.value).toMatchObject({ languages: ["eng"] })
	})
})
