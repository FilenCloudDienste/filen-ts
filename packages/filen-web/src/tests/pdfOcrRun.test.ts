import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OcrRunReport } from "@filen/office/dom/pdfedit/ocr"
import type { RecogniseOptions } from "@/features/pdf/ocr/ocrSession"
import type { OcrDialogRun } from "@/features/pdf/ocr/recogniseText.logic"

// The recognition pipeline as each test drives it: the options startOcrRun passed, and how the run ends.
const pipeline = vi.hoisted(() => ({
	options: null as RecogniseOptions | null,
	settle: null as { resolve: (report: OcrRunReport) => void; reject: (error: unknown) => void } | null
}))

const marked = vi.hoisted(() => vi.fn())

vi.mock("@/features/pdf/ocr/ocrSession", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/pdf/ocr/ocrSession")>()),
	recogniseDocument: (options: RecogniseOptions) => {
		pipeline.options = options

		return new Promise<OcrRunReport>((resolve, reject) => {
			pipeline.settle = { resolve, reject }
		})
	}
}))

vi.mock("@/features/pdf/ocr/ocrLanguagePreference", () => ({ markOcrLanguagesDownloaded: marked }))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn() } }))

const { startOcrRun } = await import("@/features/pdf/ocr/ocrRun")
const { OcrModelsError } = await import("@/features/pdf/ocr/ocrSession")

const engine = {
	render: () => Promise.reject(new Error("unused")),
	flush: () => Promise.resolve(),
	apply: () => Promise.resolve()
}

function start() {
	const states: OcrDialogRun[] = []
	const handle = startOcrRun({
		engine,
		pages: [0, 2, 5],
		languages: ["eng", "deu"],
		onState: state => {
			states.push(state)
		}
	})
	const options = pipeline.options
	const settle = pipeline.settle

	if (options === null || settle === null) throw new Error("recogniseDocument was not called")

	return { handle, states, options, settle }
}

function report(cancelled: boolean): OcrRunReport {
	return { cancelled, outcomes: [] }
}

beforeEach(() => {
	pipeline.options = null
	pipeline.settle = null
	marked.mockClear()
})

describe("startOcrRun", () => {
	it("shows the model download until the first page, then ignores its progress", () => {
		const { states, options } = start()

		options.onModels?.(1, 2)
		options.onPage?.(0, null)
		options.onModels?.(2, 2)

		expect(states).toEqual([
			{ phase: "downloading", loaded: 0, total: 0 },
			{ phase: "downloading", loaded: 1, total: 2 },
			{
				phase: "recognising",
				pages: [
					{ page: 0, status: "working", words: 0 },
					{ page: 2, status: "waiting", words: 0 },
					{ page: 5, status: "waiting", words: 0 }
				]
			}
		])
	})

	it("finishes with unfinished pages waiting again and the languages marked downloaded", async () => {
		const { handle, states, options, settle } = start()

		options.onPage?.(0, { page: 0, status: "done", words: 12, confidence: 90 })
		options.onPage?.(2, null)
		settle.resolve(report(false))

		expect(await handle.done).toEqual(report(false))
		expect(marked).toHaveBeenCalledWith(["eng", "deu"])
		expect(states.at(-1)).toEqual({
			phase: "finished",
			cancelled: false,
			pages: [
				{ page: 0, status: "done", words: 12 },
				{ page: 2, status: "waiting", words: 0 },
				{ page: 5, status: "waiting", words: 0 }
			]
		})
	})

	it("reports models that did not load apart, marking nothing downloaded", async () => {
		const { handle, states, settle } = start()

		settle.reject(new OcrModelsError("offline"))

		expect(await handle.done).toBeNull()
		expect(states.at(-1)).toEqual({ phase: "modelsFailed" })
		expect(marked).not.toHaveBeenCalled()
	})

	it("finishes a cancelled run as cancelled, whatever the pipeline rejects with", async () => {
		const { handle, states, options, settle } = start()

		options.onPage?.(0, null)
		handle.cancel()

		expect(options.signal.aborted).toBe(true)

		settle.reject(new OcrModelsError("aborted"))

		expect(await handle.done).toBeNull()
		expect(marked).not.toHaveBeenCalled()
		expect(states.at(-1)).toEqual({
			phase: "finished",
			cancelled: true,
			pages: [
				{ page: 0, status: "waiting", words: 0 },
				{ page: 2, status: "waiting", words: 0 },
				{ page: 5, status: "waiting", words: 0 }
			]
		})
	})

	it("reports a run that broke off as failed, keeping the pages laid over", async () => {
		const { handle, states, options, settle } = start()

		options.onPage?.(0, { page: 0, status: "done", words: 3, confidence: 90 })
		options.onPage?.(2, null)
		settle.reject(new Error("worker died"))

		expect(await handle.done).toBeNull()
		expect(marked).not.toHaveBeenCalled()
		expect(states.at(-1)).toEqual({
			phase: "failed",
			pages: [
				{ page: 0, status: "done", words: 3 },
				{ page: 2, status: "waiting", words: 0 },
				{ page: 5, status: "waiting", words: 0 }
			]
		})
	})
})
