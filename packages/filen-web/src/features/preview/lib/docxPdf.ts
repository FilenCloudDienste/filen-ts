import { toast } from "sonner"
import { bytesSource } from "@filen/office/core/opc"
import type { Slicing } from "@filen/office/core/opc"
import { macrotaskYield, type DocxUnlockedDocument } from "@filen/office/dom/docx"
import {
	DocxPdfExportError,
	docxPdfSnapshot,
	exportDocxPdfInWorker,
	type DocxPdfInput,
	type DocxPdfLive,
	type DocxPdfProgress,
	type DocxPdfResultData
} from "@filen/office/dom/docx/pdfClient"
import { pdfDownloadName, pdfErrorKey, pdfProgressText, pdfReportKey, pdfTitle } from "@/features/preview/lib/docxPdf.logic"
import { DOCX_FONT_URLS, docxProtection } from "@/features/preview/lib/docxEngine"
import { PDF_DETERMINISTIC } from "@/features/office/lib/pdfTestMode"
import { officeChartText } from "@/features/office/lib/chartText"
import DocxPdfWorker from "@/features/preview/workers/docxPdf.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { downloadBlob } from "@/lib/downloadBlob"
import { i18n, type PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// Download as PDF for a Word document: made in a worker of its own (ended with the export), with a toast that
// counts the pages and can cancel; the result is a local download, the file in the drive is unchanged. What
// is exported is what the pages show: the file laid out again in the worker (Final view), or the editor's
// layout with its unsaved edits.

// `untranslated` (file and editor): what the file shows that the document exported leaves out (an RTF's equations,
// DocxRtfDocument.untranslated), which the PDF's report counts.
export type DocxPdfSource =
	// The file as downloaded (not password-protected); an OpenDocument text file is laid out as the viewer does.
	// `owned`: a buffer nothing else holds, handed to the worker as it is (else a copy is).
	| {
			readonly kind: "file"
			readonly bytes: Uint8Array
			readonly format?: "docx" | "odt"
			readonly owned?: boolean
			readonly untranslated?: number
	  }
	// A password-protected file's decrypted package, unlocked for this export.
	| { readonly kind: "unlocked"; readonly document: DocxUnlockedDocument }
	// The editor's document, unsaved edits included, in the Final view; `markup`: the editor shows tracked changes or
	// comments, which the PDF leaves out (the toast says so).
	| {
			readonly kind: "editor"
			readonly live: (signal: AbortSignal) => Promise<DocxPdfLive | undefined>
			readonly markup: boolean
			readonly untranslated?: number
	  }

function worker() {
	const instance = new DocxPdfWorker()

	return {
		post(message: unknown, transfer: readonly ArrayBuffer[]) {
			instance.postMessage(message, [...transfer])
		},
		listen(onMessage: (data: unknown) => void, onError: () => void) {
			instance.addEventListener("message", event => {
				onMessage(event.data)
			})
			instance.addEventListener("error", () => {
				// A deploy that changed this worker removes its old file (appUpdate.ts).
				recoverIfNewerBuild()
				onError()
			})
			instance.addEventListener("messageerror", onError)
		},
		terminate() {
			instance.terminate()
		}
	}
}

// The editor's snapshot is built on this thread: a macrotask turn (a message, which browsers do not clamp as
// they clamp nested timers) once each slice is up.
const SNAPSHOT_SLICE_MS = 8

function snapshotSlicing(): Slicing {
	return { pause: macrotaskYield(), sliceMs: SNAPSHOT_SLICE_MS, now: () => performance.now() }
}

async function inputOf(source: DocxPdfSource, fileName: string, signal: AbortSignal): Promise<DocxPdfInput> {
	switch (source.kind) {
		case "file":
			// A copy of its own unless the caller's is: the preview cache keeps the file's buffer.
			return { kind: "bytes", bytes: source.owned === true ? source.bytes : source.bytes.slice(), fontUrls: DOCX_FONT_URLS }
		case "unlocked":
			return { kind: "bytes", bytes: (await source.document.take({ signal })).bytes, fontUrls: DOCX_FONT_URLS }
		case "editor": {
			const live = await source.live(signal)

			if (live === undefined) {
				throw new DocxPdfExportError("openFailed", "The document is not open")
			}

			return {
				kind: "snapshot",
				document: await docxPdfSnapshot(live, { copy: true, title: pdfTitle(fileName), signal, slicing: snapshotSlicing() })
			}
		}
	}
}

export interface DocxPdfMake {
	readonly signal: AbortSignal
	readonly onProgress: (progress: DocxPdfProgress | null) => void
	// Encrypts the PDF (a protected document's own password).
	readonly password?: string | undefined
}

// Makes the PDF in a worker of its own (ended with the export); rejects with a DocxPdfExportError. An unlocked
// source is released once done, whatever the outcome.
export async function makeDocxPdf(source: DocxPdfSource, fileName: string, make: DocxPdfMake): Promise<DocxPdfResultData> {
	try {
		const input = await inputOf(source, fileName, make.signal)

		return await exportDocxPdfInWorker(worker, {
			input,
			options: {
				title: pdfTitle(fileName),
				lang: i18n.language,
				chartText: officeChartText(),
				...(source.kind === "file" && source.format !== undefined ? { format: source.format } : {}),
				...(source.kind !== "unlocked" && source.untranslated !== undefined && source.untranslated > 0
					? { untranslated: source.untranslated }
					: {}),
				...(make.password === undefined ? {} : { password: make.password }),
				...(PDF_DETERMINISTIC ? { deterministic: true } : {})
			},
			signal: make.signal,
			onProgress: make.onProgress
		})
	} finally {
		if (source.kind === "unlocked") source.document.release()
	}
}

// What a made PDF tells the user beside its download: what it had to leave out or simplify (once, logged).
export function reportDocxPdf(result: DocxPdfResultData): PreviewKey | null {
	const key = pdfReportKey(result.report)

	if (key !== null) {
		log.warn("docx", "pdf export simplified", { missing: result.report.missing, refused: result.report.refused })
	}

	return key
}

// What a failed export tells the user (logged when it is not one the user caused); null: their own Cancel.
export function docxPdfFailure(error: unknown, aborted: boolean): PreviewKey | null {
	const reason = error instanceof DocxPdfExportError ? error.reason : aborted ? "aborted" : "failed"

	if (reason === "failed" || reason === "workerFailed" || reason === "openFailed") log.error("docx", "pdf export failed", error)

	return pdfErrorKey(reason)
}

let exports = 0

// Makes the PDF and downloads it as "<name>.pdf". `password` encrypts it (a protected document's own).
export async function downloadDocxPdf(source: DocxPdfSource, fileName: string, password?: string): Promise<void> {
	const id = `docx-pdf-${String(++exports)}`
	const controller = new AbortController()
	const action = {
		label: i18n.t("preview:previewDocxPdfCancel"),
		onClick: () => {
			controller.abort()
		}
	}
	const show = (progress: DocxPdfProgress | null): void => {
		const text = pdfProgressText(progress)

		toast.loading(
			text.key === "previewDocxPdfProgress"
				? i18n.t("preview:previewDocxPdfProgress", { done: text.done, total: text.total })
				: i18n.t("preview:previewDocxPdfPreparing"),
			{
				id,
				action,
				duration: Number.POSITIVE_INFINITY,
				...(source.kind === "editor" && source.markup ? { description: i18n.t("preview:previewDocxPdfFinalOnly") } : {})
			}
		)
	}

	show(null)

	try {
		const result = await makeDocxPdf(source, fileName, { signal: controller.signal, onProgress: show, password })

		downloadBlob(pdfDownloadName(fileName), result.blob as Blob)
		toast.dismiss(id)

		const reportKey = reportDocxPdf(result)

		if (reportKey !== null) {
			toast.warning(i18n.t(`preview:${reportKey}`))
		}
	} catch (error) {
		const key = docxPdfFailure(error, controller.signal.aborted)

		toast.dismiss(id)

		if (key !== null) {
			toast.error(i18n.t(`preview:${key}`))
		}
	}
}

// A password-protected file's password checked for its PDF: the file is unlocked again with it (where the
// docx engine runs; nothing decrypted reaches this thread). Accepted: the unlocked document, to export from or
// release. The password itself is never kept.
export async function unlockForPdf(
	fileBytes: Uint8Array,
	password: string,
	signal: AbortSignal
): Promise<
	{ readonly verdict: "accepted"; readonly document: DocxUnlockedDocument } | { readonly verdict: "wrong" | "aborted" | "failed" }
> {
	const opened = await docxProtection.open(bytesSource(fileBytes), { signal })

	if (opened.kind === "aborted") {
		return { verdict: "aborted" }
	}

	if (opened.kind !== "needsPassword") {
		return { verdict: "failed" }
	}

	const unlocked = await opened.locked.unlock(password, { signal })

	if (unlocked.ok) {
		return { verdict: "accepted", document: unlocked.document }
	}

	opened.locked.dispose()

	return { verdict: unlocked.reason === "wrongPassword" ? "wrong" : unlocked.reason === "aborted" ? "aborted" : "failed" }
}
