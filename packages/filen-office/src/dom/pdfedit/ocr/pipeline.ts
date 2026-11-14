import { OCR_BATCH_PAGES, ocrOverlayMatrix, type OcrMatrix } from "../../../core/pdfedit/ocrGeometry"
import type { OcrPageEdit } from "./page"
import type { OcrPageResult, OcrRecogniseArgs } from "./protocol"

// Text recognition over many pages, independent of where each step runs: the engine renders pages (in batches of
// OCR_BATCH_PAGES, its store emptied after each), the recognisers read them (one per worker, each busy with one page
// at a time), and the engine lays each page's text over it as soon as it is read (one journal operation per page).
// Each rendered page's pixels go to exactly one recogniser and are transferred, never copied. With `exclusive` a
// batch is recognised only after it was rendered (one heavy worker busy at a time, for small-memory devices).

export interface OcrRenderedPage {
	readonly pixels: Uint8Array<ArrayBuffer>
	readonly width: number
	readonly height: number
	readonly stride: number
	readonly dpi: number
	readonly pixelToPage: OcrMatrix
}

export type OcrPageOutcome =
	| { readonly page: number; readonly status: "done"; readonly words: number; readonly confidence: number }
	| { readonly page: number; readonly status: "failed"; readonly reason: string }

export interface OcrRunReport {
	readonly outcomes: readonly OcrPageOutcome[]
	// Stopped before every page was tried.
	readonly cancelled: boolean
}

export interface OcrPipeline {
	readonly pages: readonly number[]
	render(page: number): Promise<OcrRenderedPage>
	// Empties the engine's store (MuPDF emptyStore) after a batch.
	flush(): Promise<void>
	readonly recognisers: readonly ((args: OcrRecogniseArgs) => Promise<OcrPageResult>)[]
	apply(edit: OcrPageEdit): Promise<void>
	readonly exclusive?: boolean
	readonly signal?: { readonly aborted: boolean }
	// A page started (rendering) or settled.
	onPage?(page: number, outcome: OcrPageOutcome | null): void
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export async function runOcrPages(pipeline: OcrPipeline): Promise<OcrRunReport> {
	if (pipeline.recognisers.length === 0) throw new Error("no recogniser")

	const outcomes: OcrPageOutcome[] = []
	const idle = [...pipeline.recognisers]
	const waiting: ((recognise: (args: OcrRecogniseArgs) => Promise<OcrPageResult>) => void)[] = []
	const aborted = (): boolean => pipeline.signal?.aborted === true

	const settle = (outcome: OcrPageOutcome): void => {
		outcomes.push(outcome)
		pipeline.onPage?.(outcome.page, outcome)
	}

	const acquire = (): Promise<(args: OcrRecogniseArgs) => Promise<OcrPageResult>> => {
		const free = idle.pop()

		return free === undefined ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve(free)
	}

	const release = (recognise: (args: OcrRecogniseArgs) => Promise<OcrPageResult>): void => {
		const next = waiting.shift()

		if (next === undefined) idle.push(recognise)
		else next(recognise)
	}

	const read = async (page: number, rendered: OcrRenderedPage): Promise<void> => {
		const recognise = await acquire()
		let result: OcrPageResult

		try {
			result = await recognise({
				pixels: rendered.pixels,
				width: rendered.width,
				height: rendered.height,
				stride: rendered.stride,
				dpi: rendered.dpi,
				orient: true
			})
		} catch (error) {
			// A cancel terminates the recognisers under their pages: not a failure.
			if (!aborted()) settle({ page, status: "failed", reason: reasonOf(error) })

			return
		} finally {
			release(recognise)
		}

		if (aborted()) return

		try {
			await pipeline.apply({
				page,
				pdf: result.pdf,
				matrix: ocrOverlayMatrix(rendered.pixelToPage, rendered.width, rendered.height, rendered.dpi, result.turns)
			})
			settle({ page, status: "done", words: result.words, confidence: result.confidence })
		} catch (error) {
			settle({ page, status: "failed", reason: reasonOf(error) })
		}
	}

	for (let at = 0; at < pipeline.pages.length && !aborted(); at += OCR_BATCH_PAGES) {
		const batch = pipeline.pages.slice(at, at + OCR_BATCH_PAGES)
		const rendered: { readonly page: number; readonly value: OcrRenderedPage }[] = []
		const reading: Promise<void>[] = []

		for (const page of batch) {
			if (aborted()) break

			pipeline.onPage?.(page, null)

			try {
				const value = await pipeline.render(page)

				if (pipeline.exclusive === true) rendered.push({ page, value })
				else reading.push(read(page, value))
			} catch (error) {
				settle({ page, status: "failed", reason: reasonOf(error) })
			}
		}

		await pipeline.flush().catch(() => undefined)

		for (const { page, value } of rendered) reading.push(read(page, value))

		await Promise.all(reading)
	}

	return { outcomes, cancelled: aborted() || outcomes.length < pipeline.pages.length }
}
