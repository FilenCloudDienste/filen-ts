import { toast } from "sonner"
import type { SlideRef } from "@filen/office/core/presentation"
import { isPickerCancelled } from "@/features/drive/lib/saveDownload"
import { zipDelivery } from "@/features/drive/lib/downloadAsZip"
import { exportToast, type PresentationExportTarget } from "@/features/presentation/hooks/usePresentationPdfExport"
import { blobSink, runPresentationJob } from "@/features/presentation/lib/presentationJobs"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"
import { downloadBlob } from "@/lib/downloadBlob"

// File ▸ Export as images: the current slide as "<name>.png" (or .jpg), or every slide as a stored zip of
// "Slide<n>.png" saved as the drive's bulk downloads are (zipDelivery: a picked file or the service worker's streamed
// download; one image in memory at a time). Made in a jobs worker from the deck as it is now. Offered only where the
// file may be downloaded.

export interface ImageExportChoice {
	readonly format: "png" | "jpeg"
	readonly widthPx: number
	readonly scope: "current" | "all"
}

export interface ImageExportTarget extends PresentationExportTarget {
	// The slide on show.
	readonly current: SlideRef | undefined
}

const JPEG_QUALITY = 0.92

async function exportImages(target: ImageExportTarget, choice: ImageExportChoice): Promise<void> {
	const stem = fileStem(target.fileName)
	const run = exportToast("previewPptxExportImagesProgress")
	const request = {
		format: choice.format,
		widthPx: choice.widthPx,
		...(choice.format === "jpeg" ? { quality: JPEG_QUALITY } : {})
	}

	if (choice.scope === "current") {
		const current = target.current

		if (current === undefined) {
			toast.dismiss(run.id)

			return
		}

		const output = blobSink(choice.format === "jpeg" ? "image/jpeg" : "image/png")

		try {
			await runPresentationJob("raster", { ...request, slides: [current], zip: false }, target.session, output.sink, {
				signal: run.controller.signal,
				onProgress: run.progress
			})
			downloadBlob(`${stem}.${choice.format === "jpeg" ? "jpg" : "png"}`, output.blob())
			toast.dismiss(run.id)
		} catch (error) {
			run.fail(error)
		}

		return
	}

	// Asked for at once, off the click: the save picker needs the gesture.
	const delivering = zipDelivery(
		`${stem}.zip`,
		run.controller.signal,
		() => {
			run.controller.abort()
		},
		downloadBlob
	)

	try {
		const delivery = await delivering

		try {
			await runPresentationJob("raster", { ...request, zip: true }, target.session, delivery.sink, {
				signal: run.controller.signal,
				onProgress: run.progress
			})
			await delivery.saved()
			toast.dismiss(run.id)
		} catch (error) {
			await delivery.fail(error)
			throw error
		}
	} catch (error) {
		if (isPickerCancelled(error)) {
			toast.dismiss(run.id)

			return
		}

		run.fail(error)
	}
}

// The export, or undefined where it is not offered (downloads disallowed, no open session).
export function usePresentationImageExport(target: ImageExportTarget | null): ((choice: ImageExportChoice) => void) | undefined {
	const downloadable = usePreviewDownloadable()

	if (target === null || !downloadable) return undefined

	return choice => {
		void exportImages(target, choice)
	}
}
