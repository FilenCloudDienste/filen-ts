import type { OcrRunReport } from "@filen/office/dom/pdfedit/ocr"
import { markOcrLanguagesDownloaded } from "@/features/pdf/ocr/ocrLanguagePreference"
import { OcrModelsError, recogniseDocument, type OcrEngineSteps } from "@/features/pdf/ocr/ocrSession"
import { updatePageState, waitingPages, type OcrDialogRun, type OcrPageState } from "@/features/pdf/ocr/recogniseText.logic"
import type { OcrLanguage } from "@/features/pdf/ocr/languages"
import { log } from "@/lib/log"

// One recognition run for the Recognise text dialog: recogniseDocument's progress as the dialog's states. Cancel
// terminates the workers at once; pages already laid over stay (each its own undoable step).

export interface OcrRunOptions {
	readonly engine: OcrEngineSteps
	readonly pages: readonly number[]
	readonly languages: readonly OcrLanguage[]
	// Mobile WebKit: the engine idles while a batch is recognised.
	readonly exclusive?: boolean
	readonly onState: (run: OcrDialogRun) => void
}

export interface OcrRunHandle {
	cancel(): void
	readonly done: Promise<OcrRunReport | null>
}

export function startOcrRun(options: OcrRunOptions): OcrRunHandle {
	const controller = new AbortController()
	let pages: OcrPageState[] = waitingPages(options.pages)
	let recognising = false
	// Pages a cancel left unfinished read as waiting again.
	const settled = (): OcrPageState[] => pages.map(state => (state.status === "working" ? { ...state, status: "waiting" } : state))

	options.onState({ phase: "downloading", loaded: 0, total: 0 })

	const done = recogniseDocument({
		engine: options.engine,
		pages: options.pages,
		languages: options.languages,
		exclusive: options.exclusive ?? false,
		signal: controller.signal,
		onModels: (loaded, total) => {
			if (!recognising) options.onState({ phase: "downloading", loaded, total })
		},
		onPage: (page, outcome) => {
			recognising = true
			pages = updatePageState(pages, page, outcome)
			options.onState({ phase: "recognising", pages })
		}
	}).then(
		report => {
			markOcrLanguagesDownloaded(options.languages)
			options.onState({ phase: "finished", pages: settled(), cancelled: controller.signal.aborted || report.cancelled })

			for (const outcome of report.outcomes) if (outcome.status === "failed") log.warn("pdf", "ocr page failed", outcome)

			return report
		},
		(error: unknown) => {
			if (error instanceof OcrModelsError && !controller.signal.aborted) {
				log.warn("pdf", "ocr models failed", error)
				options.onState({ phase: "modelsFailed" })
			} else {
				if (!controller.signal.aborted) log.warn("pdf", "ocr failed", error)

				options.onState({ phase: "finished", pages: settled(), cancelled: controller.signal.aborted })
			}

			return null
		}
	)

	return {
		cancel: () => {
			controller.abort()
		},
		done
	}
}
