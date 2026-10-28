import type { ByteSink } from "@filen/office/core/opc"
import type { DocxPdfExportReport } from "@filen/office/dom/docx/pdfClient"
import {
	presentationJobsClient,
	type JobKind,
	type JobOutcome,
	type JobRequests,
	type PdfJobRequest,
	type PresentationSessionApi
} from "@filen/office/dom/presentation"
import { PDF_DETERMINISTIC } from "@/features/office/lib/pdfTestMode"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"
import { i18n } from "@/lib/i18n"
import PresentationJobsWorker from "@/features/presentation/workers/presentationJobs.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// The page's side of the presentation exports: one jobs worker per export, reading the open session through its
// presentation worker (unsaved edits included) and streaming its bytes back, which go into a Blob for a download or
// into a zip delivery's sink. None of the export engine is in the main bundle.

const run = presentationJobsClient(() => {
	const worker = new PresentationJobsWorker()

	worker.addEventListener("error", () => {
		recoverIfNewerBuild()
	})

	return {
		postMessage: (message, transfer) => {
			worker.postMessage(message, transfer as Transferable[])
		},
		addEventListener: (type, listener) => {
			worker.addEventListener(type, listener)
		},
		terminate: () => {
			worker.terminate()
		}
	}
})

// Bytes gathered into one Blob part this large (the browser holds Blob data, not the page's heap).
const PART = 8 * 1024 * 1024

export class PresentationJobRefused extends Error {
	readonly outcome: Exclude<JobOutcome, { kind: "done" }>

	constructor(outcome: Exclude<JobOutcome, { kind: "done" }>) {
		super(`presentation export refused: ${outcome.reason}`)
		this.name = "PresentationJobRefused"
		this.outcome = outcome
	}
}

export interface PresentationJobOptions {
	readonly signal: AbortSignal
	readonly onProgress?: (done: number, total: number) => void
}

// Runs one export, its bytes written into `sink` as they come; resolves with the outcome once all are written.
// Rejects with PresentationJobRefused when the job refused, or the abort's reason when `signal` aborted.
export async function runPresentationJob<K extends JobKind>(
	kind: K,
	request: JobRequests[K],
	session: Pick<PresentationSessionApi, "jobsPort">,
	sink: ByteSink,
	options: PresentationJobOptions
): Promise<Extract<JobOutcome, { kind: "done" }>> {
	const handle = run(kind, request, session, options.onProgress)
	const onAbort = (): void => {
		handle.abort()
	}

	options.signal.addEventListener("abort", onAbort, { once: true })

	try {
		const reading = (async () => {
			for (;;) {
				const chunk = await handle.output.read()

				if (chunk === undefined) return

				await sink.write(chunk)
			}
		})()
		// The outcome first: a refused job aborts the output, whose read then rejects.
		const outcome = await handle.done

		if (outcome.kind !== "done") {
			reading.catch(() => undefined)

			throw options.signal.aborted ? options.signal.reason : new PresentationJobRefused(outcome)
		}

		await reading
		handle.output.settled(true)
		await sink.close()

		return outcome
	} finally {
		options.signal.removeEventListener("abort", onAbort)
		handle.close()
	}
}

// A ByteSink gathering what is written into a Blob of `type`.
export function blobSink(type: string): { readonly sink: ByteSink; readonly blob: () => Blob } {
	const parts: Blob[] = []
	let pending: Uint8Array<ArrayBuffer>[] = []
	let size = 0
	const flush = (): void => {
		if (pending.length > 0) parts.push(new Blob(pending))

		pending = []
		size = 0
	}

	return {
		sink: {
			write(chunk) {
				pending.push(chunk as Uint8Array<ArrayBuffer>)
				size += chunk.length

				if (size >= PART) flush()

				return Promise.resolve()
			},
			close() {
				flush()

				return Promise.resolve()
			}
		},
		blob: () => {
			flush()

			return new Blob(parts, { type })
		}
	}
}

export interface PresentationPdfChoice {
	readonly layout: "slides" | "notes" | "handouts"
	readonly perPage?: NonNullable<PdfJobRequest["perPage"]>
	readonly includeHidden: boolean
}

// A deck's PDF as every export asks for it: titled by the file's stem where the deck names no title, in the app's
// language where it names none, protected with the deck's password when it opened with one.
export function presentationPdfRequest(fileName: string, encrypted: boolean, choice: PresentationPdfChoice): PdfJobRequest {
	return {
		layout: choice.layout,
		...(choice.layout === "handouts" ? { perPage: choice.perPage ?? 6 } : {}),
		includeHidden: choice.includeHidden,
		protect: encrypted,
		title: fileStem(fileName),
		lang: i18n.language,
		deterministic: PDF_DETERMINISTIC
	}
}

// A deck's PDF, made in a jobs worker as a Blob, with what it left out or simplified.
export async function makePresentationPdf(
	session: Pick<PresentationSessionApi, "jobsPort">,
	request: PdfJobRequest,
	options: PresentationJobOptions
): Promise<{ readonly blob: Blob; readonly report: DocxPdfExportReport | undefined }> {
	const output = blobSink("application/pdf")
	const outcome = await runPresentationJob("pdf", request, session, output.sink, options)

	return { blob: output.blob(), report: outcome.pdf }
}
