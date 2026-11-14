import { useEffect } from "react"
import { toast } from "sonner"
import { EMU_PER_PX } from "@filen/office/core/drawingml"
import type { OpenInfo, PresentationSessionApi } from "@filen/office/dom/presentation"
import { printDeck } from "@/features/presentation/print/printDeck"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { i18n } from "@/lib/i18n"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"

// File ▸ Print: the shown slides as they are now (unsaved edits included), one per sheet. A print is a copy of the
// file like a download, so it is offered only where the file may be downloaded.

let prints = 0

async function print(session: PresentationSessionApi, info: OpenInfo): Promise<void> {
	const id = `pptx-print-${String(++prints)}`
	const controller = new AbortController()
	const slides = info.slides.filter(slide => !slide.hidden).map(slide => slide.ref)
	const show = (done: number): void => {
		toast.loading(i18n.t("preview:previewPptxPrintPreparing", { done, total: slides.length }), {
			id,
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: i18n.t("preview:previewPptxExportCancel"),
				onClick: () => {
					controller.abort()
				}
			}
		})
	}

	show(0)

	try {
		await printDeck({
			session,
			slides,
			width: info.size.cx / EMU_PER_PX,
			height: info.size.cy / EMU_PER_PX,
			signal: controller.signal,
			onProgress: done => {
				if (done < slides.length) show(done)
				else toast.dismiss(id)
			}
		})
		toast.dismiss(id)
	} catch (error) {
		toast.dismiss(id)

		if (controller.signal.aborted) return

		log.error("presentation", "print failed", error)
		toast.error(i18n.t("preview:previewPptxPrintFailed"))
	}
}

// Print, or undefined where it is not offered.
export function usePresentationPrint(session: PresentationSessionApi | undefined, info: OpenInfo | undefined): (() => void) | undefined {
	const downloadable = usePreviewDownloadable()

	if (session === undefined || info === undefined || !downloadable || info.slides.every(slide => slide.hidden)) return undefined

	return () => {
		void print(session, info)
	}
}

// The attribute the print stylesheet hides the app by while a deck is open (presentationPrint.css).
const OPEN_ATTRIBUTE = "data-fo-pptx-open"
let open = 0

// Mod+P over an open deck (the editor's and the viewer's): Print where it is offered; taken anyway where it is not, so
// the browser's own print never runs from the keyboard, with a notice where downloads are disallowed. Should the
// browser print anyway (its menu), the app's chrome is hidden from it while a deck is open.
export function usePresentationPrintKey(session: PresentationSessionApi | undefined, info: OpenInfo | undefined): void {
	const downloadable = usePreviewDownloadable()
	const print = usePresentationPrint(session, info)

	useAction(
		"office.print",
		event => {
			event.preventDefault()

			if (print !== undefined) print()
			else if (!downloadable) toast.info(i18n.t("preview:previewPptxPrintNotAllowed"))
		},
		IN_EDITORS_AND_FIELDS,
		[print, downloadable]
	)

	useEffect(() => {
		const root = document.documentElement

		open++
		root.setAttribute(OPEN_ATTRIBUTE, "")

		return () => {
			open--

			if (open === 0) root.removeAttribute(OPEN_ATTRIBUTE)
		}
	}, [])
}
