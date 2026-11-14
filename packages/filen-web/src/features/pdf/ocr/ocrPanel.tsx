import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { RecogniseTextDialog } from "@/features/pdf/ocr/recogniseTextDialog"
import { startOcrRun, type OcrRunHandle } from "@/features/pdf/ocr/ocrRun"
import { ocrDownloadBytes, type OcrEngineSteps } from "@/features/pdf/ocr/ocrSession"
import {
	ocrLanguagesToDownload,
	pickedOcrLanguages,
	setOcrLanguages,
	useOcrLanguagePreference
} from "@/features/pdf/ocr/ocrLanguagePreference"
import type { OcrDialogRun } from "@/features/pdf/ocr/recogniseText.logic"
import type { OcrLanguage } from "@/features/pdf/ocr/languages"
import { PdfNoticeLine } from "@/features/pdf/tools/noticeLine"
import { withPdfSession, type PdfToolContext, type PdfToolPanelProps } from "@/features/pdf/tools/registry"
import { isAppleMobile } from "@/lib/appleMobile"
import { log } from "@/lib/log"
import { Spinner } from "@/components/ui/spinner"

// Tools › Recognise text, its panel: the editor finds the scanned pages (an image over most of the page, (near) no text), the
// dialog picks pages and languages, then recognition runs page by page (ocr/ocrRun.ts): the editor renders a batch of
// four, empties its store, the recogniser reads each page, and each page's invisible text is laid over it as its own
// undo step. On iPhone and iPad the editor waits while a batch is recognised (one heavy worker at a time). Pages done
// stay when cancelled. The text is added untagged: a document with accessibility tags is told so.

interface Scan {
	readonly pageCount: number
	readonly scanned: readonly number[]
	readonly tagged: boolean
}

// The editor's side of a run, through the session (the swap's queue keeps everything in order).
function engineSteps(context: PdfToolContext): OcrEngineSteps {
	return {
		render: page => withPdfSession(context, session => session.engine.call("ocrRender", { page })),
		flush: () => withPdfSession(context, session => session.engine.call("ocrFlush", {})).then(() => undefined),
		apply: edit =>
			withPdfSession(context, session =>
				session.dispatch("ocr.applyPage", { page: edit.page, pdf: edit.pdf, matrix: edit.matrix })
			).then(() => undefined)
	}
}

export function OcrPanel({ context }: PdfToolPanelProps) {
	const { t, i18n } = useTranslation("preview")
	const preference = useOcrLanguagePreference()
	const [picked, setPicked] = useState<OcrLanguage[] | null>(null)
	const languages = picked ?? pickedOcrLanguages(preference, i18n.language)
	const [scan, setScan] = useState<Scan | null>(null)
	const [run, setRun] = useState<OcrDialogRun | null>(null)
	const handle = useRef<OcrRunHandle | null>(null)

	const start = useEffectEvent(() => {
		withPdfSession(context, async session => {
			const { scanned } = await session.engine.call("ocrScan", {})
			const { state } = session.getSnapshot()

			return { pageCount: state.pageCount, scanned, tagged: state.tagged }
		}).then(setScan, (error: unknown) => {
			log.warn("pdf", "finding scanned pages failed", { error })
			context.finish()
		})
	})
	const end = useEffectEvent(() => {
		// Pages already laid over stay; the rest are not recognised.
		handle.current?.cancel()
		handle.current = null
	})

	useEffect(() => {
		start()

		return () => {
			end()
		}
	}, [])

	if (scan === null) {
		return (
			<div
				role="status"
				className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			>
				<Spinner
					aria-hidden="true"
					className="size-3.5 shrink-0"
				/>
				<p className="min-w-0 flex-1">{t("previewPdfOcrFinding")}</p>
			</div>
		)
	}

	return (
		<RecogniseTextDialog
			pageCount={scan.pageCount}
			scanned={scan.scanned}
			languages={languages}
			downloadBytes={ocrDownloadBytes(ocrLanguagesToDownload(preference, languages))}
			run={run}
			onLanguagesChange={next => {
				setPicked(next)
				setOcrLanguages(next)
			}}
			onStart={pages => {
				const started = startOcrRun({
					engine: engineSteps(context),
					pages,
					languages,
					exclusive: isAppleMobile(),
					onState: setRun
				})

				handle.current = started
				void started.done.then(report => {
					if (handle.current === started) handle.current = null

					if (scan.tagged && report?.outcomes.some(outcome => outcome.status === "done") === true) {
						context.notify(
							<PdfNoticeLine
								onDismiss={() => {
									context.notify(null)
								}}
							>
								{t("previewPdfTagged")}
							</PdfNoticeLine>
						)
					}
				})
			}}
			onCancel={() => {
				handle.current?.cancel()
			}}
			onClose={() => {
				context.finish()
			}}
		/>
	)
}
